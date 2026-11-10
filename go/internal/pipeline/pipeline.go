// Package pipeline contains the probe and transcode handlers. They are plain structs
// over small interfaces so integration tests can run them against real containers.
package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"streamforge/internal/events"
	"streamforge/internal/media"
	"streamforge/internal/progress"
	"streamforge/internal/telemetry"
	"streamforge/internal/worker"
)

// step runs fn inside a child span named after a pipeline step.
func step(ctx context.Context, name string, fn func(context.Context) error) error {
	ctx, span := telemetry.Tracer("pipeline").Start(ctx, name)
	defer span.End()
	err := fn(ctx)
	if err != nil {
		span.RecordError(err)
	}
	return err
}

// ObjectStore is the storage subset the handlers use.
type ObjectStore interface {
	Download(ctx context.Context, bucket, key, path string) error
	Exists(ctx context.Context, bucket, key string) (bool, error)
	UploadDir(ctx context.Context, bucket, prefix, dir string, last ...string) error
	PresignGet(ctx context.Context, bucket, key string, ttl time.Duration) (string, error)
}

// Deps are shared by all handlers.
type Deps struct {
	Store          ObjectStore
	Pub            events.Publisher
	Progress       progress.Reporter
	Log            *slog.Logger
	JobStatusTopic string
	FFmpeg         string // binary paths (default "ffmpeg"/"ffprobe")
	FFprobe        string
	TmpDir         string
}

func (d *Deps) status(ctx context.Context, videoID, task string, state events.JobState, attempt int, errMsg string, result map[string]any) error {
	err := d.Pub.Publish(ctx, d.JobStatusTopic, events.JobStatus{
		Type: "job.status", VideoID: videoID, Task: task, State: state, Attempt: attempt,
		Error: errMsg, Result: result, At: time.Now().UTC(),
	})
	if err != nil {
		return fmt.Errorf("publish %s status: %w", state, err)
	}
	return nil
}

// GiveUp returns a worker.Consumer OnGiveUp hook that publishes a FAILED status with a
// user-facing reason.
func (d *Deps) GiveUp(task string) func(context.Context, worker.Message, error) {
	return func(ctx context.Context, m worker.Message, err error) {
		var ref struct {
			VideoID string `json:"videoId"`
		}
		if json.Unmarshal([]byte(m.Body), &ref) != nil || ref.VideoID == "" {
			d.Log.ErrorContext(ctx, "cannot report failure: message has no videoId", "body", truncate(m.Body, 200))
			return
		}
		reason, ok := media.IsInvalidInput(err)
		if !ok {
			reason = fmt.Sprintf("Processing failed after %d attempts", m.ReceiveCount)
		}
		if perr := d.status(ctx, ref.VideoID, task, events.Failed, m.ReceiveCount, reason, map[string]any{"detail": truncate(err.Error(), 500)}); perr != nil {
			d.Log.ErrorContext(ctx, "could not publish FAILED status", "videoId", ref.VideoID, "err", perr)
		}
	}
}

func decode[T any](body string) (T, error) {
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return v, worker.Permanent(fmt.Errorf("malformed message: %w", err))
	}
	return v, nil
}

// --- probe ---------------------------------------------------------------

type Probe struct {
	Deps
	VideoProbedTopic string
}

func (p *Probe) Handle(ctx context.Context, m worker.Message) error {
	ev, err := decode[events.VideoUploaded](m.Body)
	if err != nil {
		return err
	}
	if ev.VideoID == "" || ev.Bucket == "" || ev.Key == "" {
		return worker.Permanent(errors.New("malformed message: missing videoId/bucket/key"))
	}
	log := p.Log.With("videoId", ev.VideoID, "task", "probe")
	if err := p.status(ctx, ev.VideoID, "probe", events.Running, m.ReceiveCount, "", nil); err != nil {
		return err
	}
	p.Progress.Report(ctx, progress.Event{OwnerID: ev.OwnerID, VideoID: ev.VideoID, Task: "probe", Stage: "probing"})

	url, err := p.Store.PresignGet(ctx, ev.Bucket, ev.Key, 10*time.Minute)
	if err != nil {
		return err
	}
	pctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(pctx, or(p.FFprobe, "ffprobe"), media.ProbeArgs(url)...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := step(pctx, "ffprobe", func(context.Context) error { return cmd.Run() }); err != nil {
		if looksInvalid(stderr.String()) {
			return worker.Permanent(&media.InvalidInputError{Reason: "The file is not a readable video"})
		}
		return fmt.Errorf("ffprobe: %w: %s", err, truncate(stderr.String(), 300))
	}
	info, err := media.ParseProbe(stdout.Bytes())
	if err == nil {
		err = media.Validate(info)
	}
	if err != nil {
		return worker.Permanent(err)
	}

	rs := media.PlanRenditions(info.Width, info.Height)
	probed := events.VideoProbed{
		Type: "video.probed", VideoID: ev.VideoID, OwnerID: ev.OwnerID, Bucket: ev.Bucket, Key: ev.Key,
		DurationSeconds: info.DurationSeconds, Width: info.Width, Height: info.Height,
		HasAudio: info.HasAudio, Renditions: rs,
	}
	if err := p.Pub.Publish(ctx, p.VideoProbedTopic, probed); err != nil {
		return fmt.Errorf("publish video-probed: %w", err)
	}
	log.InfoContext(ctx, "probed", "duration", info.DurationSeconds, "width", info.Width, "height", info.Height, "renditions", len(rs))
	p.Progress.Report(ctx, progress.Event{OwnerID: ev.OwnerID, VideoID: ev.VideoID, Task: "probe", Stage: "probing", Percent: 100})
	return p.status(ctx, ev.VideoID, "probe", events.Succeeded, m.ReceiveCount, "", map[string]any{
		"durationSeconds": info.DurationSeconds, "width": info.Width, "height": info.Height, "hasAudio": info.HasAudio,
	})
}

// --- transcode -----------------------------------------------------------

type Transcode struct {
	Deps
	ProcessedBucket string
}

// HLSPrefix is the deterministic output location for a video's HLS ladder.
func HLSPrefix(videoID string) string { return videoID + "/hls" }

const masterPlaylist = "master.m3u8"

func (t *Transcode) Handle(ctx context.Context, m worker.Message) error {
	ev, err := decode[events.VideoProbed](m.Body)
	if err != nil {
		return err
	}
	if ev.VideoID == "" || len(ev.Renditions) == 0 {
		return worker.Permanent(errors.New("malformed message: missing videoId/renditions"))
	}
	log := t.Log.With("videoId", ev.VideoID, "task", "transcode")
	prefix := HLSPrefix(ev.VideoID)
	result := map[string]any{"master": prefix + "/" + masterPlaylist, "renditions": names(ev.Renditions)}

	// Idempotency: the master playlist is written last, so its presence means a previous
	// delivery finished. Redelivered messages just re-confirm success.
	done, err := t.Store.Exists(ctx, t.ProcessedBucket, prefix+"/"+masterPlaylist)
	if err != nil {
		return err
	}
	if done {
		log.InfoContext(ctx, "output already committed; skipping")
		return t.status(ctx, ev.VideoID, "transcode", events.Succeeded, m.ReceiveCount, "", result)
	}
	if err := t.status(ctx, ev.VideoID, "transcode", events.Running, m.ReceiveCount, "", nil); err != nil {
		return err
	}

	work, err := os.MkdirTemp(t.TmpDir, "transcode-"+ev.VideoID+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	src := filepath.Join(work, "source")
	if err := step(ctx, "download source", func(ctx context.Context) error { return t.Store.Download(ctx, ev.Bucket, ev.Key, src) }); err != nil {
		return err
	}
	out := filepath.Join(work, "hls")
	for _, r := range ev.Renditions {
		if err := os.MkdirAll(filepath.Join(out, r.Name), 0o755); err != nil {
			return err
		}
	}

	start := time.Now()
	report := func(f float64) {
		t.Progress.Report(ctx, progress.Event{OwnerID: ev.OwnerID, VideoID: ev.VideoID, Task: "transcode", Stage: "transcoding", Percent: f * 100})
	}
	if err := step(ctx, "ffmpeg transcode", func(ctx context.Context) error {
		return t.runFFmpeg(ctx, media.TranscodeArgs(src, out, ev.Renditions, ev.HasAudio), ev.DurationSeconds, report)
	}); err != nil {
		return err
	}
	log.InfoContext(ctx, "transcoded", "seconds", time.Since(start).Seconds())

	if err := step(ctx, "upload hls", func(ctx context.Context) error {
		return t.Store.UploadDir(ctx, t.ProcessedBucket, prefix, out, masterPlaylist)
	}); err != nil {
		return err
	}
	result["transcodeSeconds"] = time.Since(start).Seconds()
	return t.status(ctx, ev.VideoID, "transcode", events.Succeeded, m.ReceiveCount, "", result)
}

func (t *Transcode) runFFmpeg(ctx context.Context, args []string, duration float64, report func(float64)) error {
	cmd := exec.CommandContext(ctx, or(t.FFmpeg, "ffmpeg"), args...)
	cmd.WaitDelay = 5 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start ffmpeg: %w", err)
	}
	media.ReadProgress(stdout, duration, report)
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if looksInvalid(stderr.String()) {
			return worker.Permanent(&media.InvalidInputError{Reason: "The video could not be decoded"})
		}
		return fmt.Errorf("ffmpeg: %w: %s", err, truncate(stderr.String(), 500))
	}
	return nil
}

func looksInvalid(stderr string) bool {
	for _, s := range []string{"Invalid data found when processing input", "moov atom not found", "could not find codec parameters", "Error while decoding"} {
		if strings.Contains(stderr, s) {
			return true
		}
	}
	return false
}

func names(rs []events.Rendition) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.Name
	}
	return out
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
