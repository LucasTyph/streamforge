// Command probe consumes video-uploaded events, runs ffprobe, validates the upload and
// publishes video-probed. Env: PROBE_QUEUE_URL, VIDEO_PROBED_TOPIC_ARN, JOB_STATUS_TOPIC_ARN,
// REDIS_URL (optional), AWS_* (endpoints via AWS_ENDPOINT_URL_<SERVICE>).
package main

import (
	"time"

	"streamforge/internal/app"
	"streamforge/internal/pipeline"
	"streamforge/internal/worker"
)

func main() {
	ctx, stop := app.SignalContext()
	defer stop()
	rt := app.New(ctx, "probe-worker")
	app.ServeHealth(ctx, rt.Log)

	h := &pipeline.Probe{Deps: rt.Deps, VideoProbedTopic: app.MustEnv("VIDEO_PROBED_TOPIC_ARN")}
	c := &worker.Consumer{
		SQS: rt.SQS, QueueURL: app.MustEnv("PROBE_QUEUE_URL"), Log: rt.Log,
		Handle: h.Handle, OnGiveUp: rt.Deps.GiveUp("probe"),
		Visibility: 60 * time.Second, DrainTimeout: 30 * time.Second,
	}
	_ = c.Run(ctx)
	rt.Log.Info("exited")
}
