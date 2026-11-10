package media

import (
	"fmt"
	"math"
	"strings"
)

// SpritePlan describes a scrub-preview sprite sheet: one thumbnail every Interval
// seconds, laid out Cols x Rows, each ThumbW x ThumbH.
type SpritePlan struct {
	Interval       float64
	Count          int
	Cols, Rows     int
	ThumbW, ThumbH int
}

const (
	maxSpriteThumbs = 100
	spriteCols      = 10
	spriteThumbW    = 160
	posterMaxW      = 1280
)

// PlanSprite picks an interval so a video gets at most 100 thumbnails (>= 1 s apart).
func PlanSprite(duration float64, width, height int) SpritePlan {
	interval := math.Max(1, math.Ceil(duration/maxSpriteThumbs))
	count := max(1, int(math.Ceil(duration/interval)))
	cols := min(spriteCols, count)
	tw := min(spriteThumbW, even(width))
	th := max(2, even(int(math.Round(float64(tw)*float64(height)/float64(width)))))
	return SpritePlan{Interval: interval, Count: count, Cols: cols, Rows: (count + cols - 1) / cols, ThumbW: tw, ThumbH: th}
}

// SpriteVTT returns a WebVTT file mapping time ranges to sprite regions
// (`sprite.jpg#xywh=x,y,w,h`), the format most web players use for scrub previews.
func SpriteVTT(p SpritePlan, duration float64, spriteURL string) string {
	var b strings.Builder
	b.WriteString("WEBVTT\n")
	for i := 0; i < p.Count; i++ {
		start := float64(i) * p.Interval
		end := math.Min(start+p.Interval, duration)
		if end <= start {
			break
		}
		x, y := (i%p.Cols)*p.ThumbW, (i/p.Cols)*p.ThumbH
		fmt.Fprintf(&b, "\n%s --> %s\n%s#xywh=%d,%d,%d,%d\n", vttTime(start), vttTime(end), spriteURL, x, y, p.ThumbW, p.ThumbH)
	}
	return b.String()
}

func vttTime(s float64) string {
	ms := int(math.Round(s * 1000))
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
}

// PosterArgs grabs one frame ~10% in (max 3 s), scaled to at most 1280 px wide (never up).
func PosterArgs(input, out string, duration float64, width int) []string {
	at := math.Min(3, duration*0.1)
	w := min(posterMaxW, even(width))
	return []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-ss", fmt.Sprintf("%.3f", at), "-i", input, "-frames:v", "1",
		"-vf", fmt.Sprintf("scale=%d:-2", w), "-q:v", "3", out}
}

// SpriteArgs renders the whole sprite sheet in one pass with the fps + tile filters.
func SpriteArgs(input, out string, p SpritePlan) []string {
	vf := fmt.Sprintf("fps=1/%g,scale=%d:%d,tile=%dx%d", p.Interval, p.ThumbW, p.ThumbH, p.Cols, p.Rows)
	return []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-i", input, "-an", "-vf", vf, "-frames:v", "1", "-q:v", "5", out}
}
