package media

import (
	"strings"
	"testing"
)

func TestPlanSprite(t *testing.T) {
	cases := []struct {
		dur  float64
		w, h int
		want SpritePlan
	}{
		{10, 1280, 720, SpritePlan{Interval: 1, Count: 10, Cols: 10, Rows: 1, ThumbW: 160, ThumbH: 90}},
		{300, 1920, 1080, SpritePlan{Interval: 3, Count: 100, Cols: 10, Rows: 10, ThumbW: 160, ThumbH: 90}},
		{4.5, 720, 1280, SpritePlan{Interval: 1, Count: 5, Cols: 5, Rows: 1, ThumbW: 160, ThumbH: 284}},
		{2, 100, 60, SpritePlan{Interval: 1, Count: 2, Cols: 2, Rows: 1, ThumbW: 100, ThumbH: 60}}, // never upscale
	}
	for _, c := range cases {
		if got := PlanSprite(c.dur, c.w, c.h); got != c.want {
			t.Errorf("PlanSprite(%v,%d,%d) = %+v, want %+v", c.dur, c.w, c.h, got, c.want)
		}
	}
}

func TestSpriteVTT(t *testing.T) {
	p := PlanSprite(12.5, 1280, 720) // 13 thumbs at 1 s, 10 per row
	vtt := SpriteVTT(p, 12.5, "sprite.jpg")
	if !strings.HasPrefix(vtt, "WEBVTT\n") {
		t.Fatal("missing header")
	}
	for _, want := range []string{
		"00:00:00.000 --> 00:00:01.000\nsprite.jpg#xywh=0,0,160,90",
		"00:00:09.000 --> 00:00:10.000\nsprite.jpg#xywh=1440,0,160,90",
		"00:00:10.000 --> 00:00:11.000\nsprite.jpg#xywh=0,90,160,90", // wraps to row 2
		"00:00:12.000 --> 00:00:12.500\nsprite.jpg#xywh=320,90,160,90",
	} {
		if !strings.Contains(vtt, want) {
			t.Errorf("vtt missing %q", want)
		}
	}
	if n := strings.Count(vtt, "-->"); n != 13 {
		t.Errorf("cues = %d, want 13", n)
	}
}

func TestThumbArgs(t *testing.T) {
	poster := strings.Join(PosterArgs("in", "poster.jpg", 60, 1920), " ")
	if !strings.Contains(poster, "-ss 3.000") || !strings.Contains(poster, "scale=1280:-2") {
		t.Errorf("poster args: %s", poster)
	}
	small := strings.Join(PosterArgs("in", "poster.jpg", 5, 320), " ")
	if !strings.Contains(small, "-ss 0.500") || !strings.Contains(small, "scale=320:-2") {
		t.Errorf("small poster args: %s", small)
	}
	sprite := strings.Join(SpriteArgs("in", "s.jpg", PlanSprite(300, 1920, 1080)), " ")
	if !strings.Contains(sprite, "fps=1/3,scale=160:90,tile=10x10") {
		t.Errorf("sprite args: %s", sprite)
	}
}
