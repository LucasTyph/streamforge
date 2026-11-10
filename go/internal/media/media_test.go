package media

import (
	"slices"
	"strconv"
	"strings"
	"testing"

	"streamforge/internal/events"
)

func TestPlanRenditions(t *testing.T) {
	names := func(rs []events.Rendition) []string {
		var out []string
		for _, r := range rs {
			out = append(out, r.Name+":"+strconv.Itoa(r.Width)+"x"+strconv.Itoa(r.Height))
		}
		return out
	}
	cases := []struct {
		w, h int
		want []string
	}{
		{1920, 1080, []string{"360p:640x360", "720p:1280x720"}},
		{1280, 720, []string{"360p:640x360", "720p:1280x720"}},
		{640, 360, []string{"360p:640x360"}},                   // never upscale to 720p
		{320, 240, []string{"240p:320x240"}},                   // below the ladder: keep source size
		{720, 1280, []string{"360p:360x640", "720p:720x1280"}}, // portrait
		{853, 480, []string{"360p:638x360"}},                   // odd widths rounded to even
	}
	for _, c := range cases {
		if got := names(PlanRenditions(c.w, c.h)); !slices.Equal(got, c.want) {
			t.Errorf("PlanRenditions(%d,%d) = %v, want %v", c.w, c.h, got, c.want)
		}
	}
}

func TestParseProbeAndValidate(t *testing.T) {
	ok := []byte(`{"streams":[{"codec_type":"video","width":1280,"height":720},{"codec_type":"audio"}],
		"format":{"format_name":"mov,mp4","duration":"30.03"}}`)
	info, err := ParseProbe(ok)
	if err != nil || !info.HasVideo || !info.HasAudio || info.Width != 1280 || info.DurationSeconds != 30.03 {
		t.Fatalf("ParseProbe = %+v, %v", info, err)
	}
	if err := Validate(info); err != nil {
		t.Fatalf("Validate: %v", err)
	}

	rotated, _ := ParseProbe([]byte(`{"streams":[{"codec_type":"video","width":1920,"height":1080,
		"side_data_list":[{"rotation":-90}]}],"format":{"duration":"5"}}`))
	if rotated.Width != 1080 || rotated.Height != 1920 {
		t.Errorf("rotation not applied: %+v", rotated)
	}

	for name, in := range map[string][]byte{
		"not json":  []byte("garbage"),
		"no video":  []byte(`{"streams":[{"codec_type":"audio"}],"format":{"duration":"10"}}`),
		"too long":  []byte(`{"streams":[{"codec_type":"video","width":160,"height":90}],"format":{"duration":"360"}}`),
		"no length": []byte(`{"streams":[{"codec_type":"video","width":160,"height":90}],"format":{}}`),
	} {
		info, err := ParseProbe(in)
		if err == nil {
			err = Validate(info)
		}
		if _, isInvalid := IsInvalidInput(err); !isInvalid {
			t.Errorf("%s: want InvalidInputError, got %v", name, err)
		}
	}
	if info, _ := ParseProbe([]byte(`{"streams":[{"codec_type":"video","width":160,"height":90}],"format":{"duration":"360"}}`)); Validate(info).Error() != "Video is 6:00 long; the limit is 5:00" {
		t.Errorf("unexpected message: %v", Validate(info))
	}
}

func TestTranscodeArgs(t *testing.T) {
	rs := PlanRenditions(1280, 720)
	args := strings.Join(TranscodeArgs("in.mp4", "/out", rs, true), " ")
	for _, want := range []string{
		"-filter_complex [0:v]split=2[v0][v1];[v0]scale=w=640:h=360",
		"-preset veryfast",
		"-hls_time 4",
		"-hls_playlist_type vod",
		"-var_stream_map v:0,a:0,name:360p v:1,a:1,name:720p",
		"-master_pl_name master.m3u8",
		"-progress pipe:1",
		"/out/%v/index.m3u8",
		"-g 120 -keyint_min 120 -sc_threshold 0",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q\n%s", want, args)
		}
	}
	noAudio := strings.Join(TranscodeArgs("in.mp4", "/out", rs[:1], false), " ")
	if strings.Contains(noAudio, "0:a:0") || !strings.Contains(noAudio, "-var_stream_map v:0,name:360p") {
		t.Errorf("no-audio args wrong: %s", noAudio)
	}
}

func TestReadProgress(t *testing.T) {
	in := "frame=10\nout_time_us=5000000\nprogress=continue\nout_time_us=10000000\nprogress=end\n"
	var got []float64
	ReadProgress(strings.NewReader(in), 20, func(f float64) { got = append(got, f) })
	if !slices.Equal(got, []float64{0.25, 0.5, 1}) {
		t.Errorf("progress = %v", got)
	}
}
