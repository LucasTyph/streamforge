package pipeline

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"streamforge/internal/events"
	"streamforge/internal/media"
	"streamforge/internal/progress"
	"streamforge/internal/worker"
)

// Thumbnail renders a poster frame and a scrub-preview sprite sheet + WebVTT index.
type Thumbnail struct {
	Deps
	ProcessedBucket string
}

// ThumbsPrefix is the deterministic output location for a video's thumbnails.
func ThumbsPrefix(videoID string) string { return videoID + "/thumbs" }

const spriteVTT = "sprite.vtt" // written last: the commit marker

func (t *Thumbnail) Handle(ctx context.Context, m worker.Message) error {
	ev, err := decode[events.VideoProbed](m.Body)
	if err != nil {
		return err
	}
	if ev.VideoID == "" || ev.Width <= 0 || ev.DurationSeconds <= 0 {
		return worker.Permanent(errors.New("malformed message: missing videoId/size/duration"))
	}
	prefix := ThumbsPrefix(ev.VideoID)
	result := map[string]any{"poster": prefix + "/poster.jpg", "sprite": prefix + "/sprite.jpg", "vtt": prefix + "/" + spriteVTT}

	done, err := t.Store.Exists(ctx, t.ProcessedBucket, prefix+"/"+spriteVTT)
	if err != nil {
		return err
	}
	if done {
		t.Log.Info("thumbnails already committed; skipping", "videoId", ev.VideoID)
		return t.status(ctx, ev.VideoID, "thumbnail", events.Succeeded, m.ReceiveCount, "", result)
	}
	if err := t.status(ctx, ev.VideoID, "thumbnail", events.Running, m.ReceiveCount, "", nil); err != nil {
		return err
	}
	report := func(pct float64) {
		t.Progress.Report(ctx, progress.Event{OwnerID: ev.OwnerID, VideoID: ev.VideoID, Task: "thumbnail", Stage: "thumbnails", Percent: pct})
	}
	report(0)

	work, err := os.MkdirTemp(t.TmpDir, "thumbs-"+ev.VideoID+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	src, err := t.Store.PresignGet(ctx, ev.Bucket, ev.Key, 15*time.Minute) // ffmpeg reads over HTTP
	if err != nil {
		return err
	}
	out := filepath.Join(work, "thumbs")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	plan := media.PlanSprite(ev.DurationSeconds, ev.Width, ev.Height)
	if err := t.run(ctx, media.PosterArgs(src, filepath.Join(out, "poster.jpg"), ev.DurationSeconds, ev.Width)); err != nil {
		return err
	}
	report(30)
	if err := t.run(ctx, media.SpriteArgs(src, filepath.Join(out, "sprite.jpg"), plan)); err != nil {
		return err
	}
	report(90)
	// Cue URLs are relative to the VTT file, so the same output works behind any host/CDN.
	if err := os.WriteFile(filepath.Join(out, spriteVTT), []byte(media.SpriteVTT(plan, ev.DurationSeconds, "sprite.jpg")), 0o644); err != nil {
		return err
	}
	if err := t.Store.UploadDir(ctx, t.ProcessedBucket, prefix, out, spriteVTT); err != nil {
		return err
	}
	report(100)
	return t.status(ctx, ev.VideoID, "thumbnail", events.Succeeded, m.ReceiveCount, "", result)
}

func (t *Thumbnail) run(ctx context.Context, args []string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, or(t.FFmpeg, "ffmpeg"), args...)
	cmd.Stderr = &stderr
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Run(); err != nil {
		if looksInvalid(stderr.String()) {
			return worker.Permanent(&media.InvalidInputError{Reason: "The video could not be decoded"})
		}
		return fmt.Errorf("ffmpeg: %w: %s", err, truncate(stderr.String(), 400))
	}
	return nil
}
