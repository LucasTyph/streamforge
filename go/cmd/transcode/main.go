// Command transcode consumes video-probed events and produces an HLS ladder in the
// processed bucket. Env: TRANSCODE_QUEUE_URL, PROCESSED_BUCKET, JOB_STATUS_TOPIC_ARN,
// REDIS_URL (optional), WORK_DIR (optional), AWS_*.
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
	rt := app.New(ctx, "transcode-worker")
	app.ServeHealth(ctx, rt.Log)

	h := &pipeline.Transcode{Deps: rt.Deps, ProcessedBucket: app.MustEnv("PROCESSED_BUCKET")}
	c := &worker.Consumer{
		SQS: rt.SQS, QueueURL: app.MustEnv("TRANSCODE_QUEUE_URL"), Log: rt.Log,
		Handle: h.Handle, OnGiveUp: rt.Deps.GiveUp("transcode"),
		// Heartbeats extend visibility while ffmpeg runs; a crashed worker's message
		// reappears within 2 minutes.
		Visibility: 120 * time.Second, HeartbeatInterval: 30 * time.Second,
		// On SIGTERM a transcode is released (not finished): it can take minutes.
		DrainTimeout: 5 * time.Second,
	}
	_ = c.Run(ctx)
	rt.Log.Info("exited")
}
