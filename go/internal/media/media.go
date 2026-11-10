// Package media holds pure, testable ffprobe/ffmpeg logic: parsing probe output,
// validating input, planning the rendition ladder, and building ffmpeg arguments.
package media

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"streamforge/internal/events"
)

const (
	MaxDurationSeconds = 300
	SegmentSeconds     = 4
)

// Info is the subset of ffprobe output we use.
type Info struct {
	DurationSeconds float64
	Width, Height   int
	HasVideo        bool
	HasAudio        bool
	FormatName      string
}

// InvalidInputError marks a permanent, user-facing problem with the upload.
type InvalidInputError struct{ Reason string }

func (e *InvalidInputError) Error() string { return e.Reason }

func invalid(format string, a ...any) error {
	return &InvalidInputError{Reason: fmt.Sprintf(format, a...)}
}

// IsInvalidInput reports whether err (or a wrapped error) is an InvalidInputError.
func IsInvalidInput(err error) (string, bool) {
	var ie *InvalidInputError
	if errors.As(err, &ie) {
		return ie.Reason, true
	}
	return "", false
}

// ProbeArgs are the ffprobe arguments for an input path or URL.
func ProbeArgs(input string) []string {
	return []string{"-v", "error", "-print_format", "json", "-show_format", "-show_streams", input}
}

// ParseProbe parses `ffprobe -print_format json -show_format -show_streams` output.
func ParseProbe(out []byte) (Info, error) {
	var p struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			Duration  string `json:"duration"`
			Tags      struct {
				Rotate string `json:"rotate"`
			} `json:"tags"`
			SideData []struct {
				Rotation int `json:"rotation"`
			} `json:"side_data_list"`
		} `json:"streams"`
		Format struct {
			FormatName string `json:"format_name"`
			Duration   string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &p); err != nil {
		return Info{}, invalid("Could not read the file as a video")
	}
	info := Info{FormatName: p.Format.FormatName}
	info.DurationSeconds, _ = strconv.ParseFloat(p.Format.Duration, 64)
	for _, s := range p.Streams {
		switch s.CodecType {
		case "video":
			if info.HasVideo {
				continue
			}
			info.HasVideo = true
			info.Width, info.Height = s.Width, s.Height
			rot := s.Tags.Rotate
			for _, sd := range s.SideData {
				if sd.Rotation != 0 {
					rot = strconv.Itoa(sd.Rotation)
				}
			}
			if rot == "90" || rot == "-90" || rot == "270" || rot == "-270" {
				info.Width, info.Height = info.Height, info.Width // displayed orientation
			}
			if info.DurationSeconds == 0 {
				info.DurationSeconds, _ = strconv.ParseFloat(s.Duration, 64)
			}
		case "audio":
			info.HasAudio = true
		}
	}
	return info, nil
}

// Validate enforces product limits. Errors are user-facing.
func Validate(info Info) error {
	switch {
	case !info.HasVideo || info.Width <= 0 || info.Height <= 0:
		return invalid("The file has no video stream")
	case info.DurationSeconds <= 0:
		return invalid("Could not determine the video's duration")
	case info.DurationSeconds > MaxDurationSeconds:
		return invalid("Video is %s long; the limit is 5:00", fmtDuration(info.DurationSeconds))
	}
	return nil
}

func fmtDuration(s float64) string {
	t := int(s + 0.5)
	return fmt.Sprintf("%d:%02d", t/60, t%60)
}

var ladder = []struct {
	height, kbps int
}{
	{360, 800},
	{720, 2800},
}

// PlanRenditions returns the HLS ladder for a source size. It never upscales: rungs
// taller than the source's short side are dropped, and a source smaller than the lowest
// rung gets a single rendition at its own size. Sizes are kept even (required by x264).
func PlanRenditions(width, height int) []events.Rendition {
	portrait := height > width
	short, long := height, width
	if portrait {
		short, long = width, height
	}
	var out []events.Rendition
	for _, r := range ladder {
		if r.height > short {
			continue
		}
		out = append(out, rendition(r.height, long*r.height/short, r.kbps, portrait))
	}
	if len(out) == 0 {
		kbps := ladder[0].kbps * short / ladder[0].height
		out = append(out, rendition(short, long, max(kbps, 200), portrait))
	}
	return out
}

func rendition(short, long, kbps int, portrait bool) events.Rendition {
	short, long = even(short), even(long)
	w, h := long, short
	if portrait {
		w, h = short, long
	}
	return events.Rendition{Name: fmt.Sprintf("%dp", short), Width: w, Height: h, VideoBitrate: kbps}
}

func even(n int) int { return n - n%2 }

// TranscodeArgs builds a single ffmpeg invocation producing every rendition as HLS
// (4 s segments, VOD playlists) plus a master playlist, in outDir/<name>/index.m3u8.
func TranscodeArgs(input, outDir string, rs []events.Rendition, hasAudio bool) []string {
	n := len(rs)
	var fc strings.Builder
	fmt.Fprintf(&fc, "[0:v]split=%d", n)
	for i := range rs {
		fmt.Fprintf(&fc, "[v%d]", i)
	}
	for i, r := range rs {
		fmt.Fprintf(&fc, ";[v%d]scale=w=%d:h=%d:flags=bicubic,setsar=1[v%dout]", i, r.Width, r.Height, i)
	}

	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input,
		"-filter_complex", fc.String()}
	streamMap := make([]string, n)
	gop := strconv.Itoa(SegmentSeconds * 30) // keyframe at every segment boundary (assumes <=30fps after -r)
	for i, r := range rs {
		args = append(args, "-map", fmt.Sprintf("[v%dout]", i),
			fmt.Sprintf("-c:v:%d", i), "libx264",
			fmt.Sprintf("-b:v:%d", i), fmt.Sprintf("%dk", r.VideoBitrate),
			fmt.Sprintf("-maxrate:v:%d", i), fmt.Sprintf("%dk", r.VideoBitrate*107/100),
			fmt.Sprintf("-bufsize:v:%d", i), fmt.Sprintf("%dk", r.VideoBitrate*3/2))
		streamMap[i] = fmt.Sprintf("v:%d", i)
		if hasAudio {
			args = append(args, "-map", "0:a:0", fmt.Sprintf("-c:a:%d", i), "aac", fmt.Sprintf("-b:a:%d", i), "96k")
			streamMap[i] += fmt.Sprintf(",a:%d", i)
		}
		streamMap[i] += ",name:" + r.Name
	}
	if hasAudio {
		args = append(args, "-ac", "2", "-ar", "48000")
	}
	args = append(args,
		"-r", "30", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
		"-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
		"-f", "hls", "-hls_time", strconv.Itoa(SegmentSeconds), "-hls_playlist_type", "vod",
		"-hls_flags", "independent_segments",
		"-hls_segment_filename", outDir+"/%v/seg_%03d.ts",
		"-master_pl_name", "master.m3u8",
		"-var_stream_map", strings.Join(streamMap, " "),
		"-progress", "pipe:1", "-nostats",
		outDir+"/%v/index.m3u8",
	)
	return args
}

// ReadProgress parses `ffmpeg -progress` key=value output and calls fn with the
// fraction done (0..1) each time a progress block ends.
func ReadProgress(r io.Reader, durationSeconds float64, fn func(float64)) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		switch k {
		case "out_time_us", "out_time_ms": // both are microseconds in ffmpeg
			us, err := strconv.ParseFloat(v, 64)
			if err == nil && durationSeconds > 0 {
				fn(min(max(us/1e6/durationSeconds, 0), 1))
			}
		case "progress":
			if v == "end" {
				fn(1)
			}
		}
	}
}
