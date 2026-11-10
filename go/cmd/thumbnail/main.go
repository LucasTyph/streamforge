// Command thumbnail consumes video-probed events and writes a poster, a sprite sheet and
// a WebVTT scrub-preview index to the processed bucket. Env: THUMBNAIL_QUEUE_URL,
// PROCESSED_BUCKET, JOB_STATUS_TOPIC_ARN, REDIS_URL (optional), WORK_DIR (optional), AWS_*.
package main

import (
	"context"
	"time"

	"streamforge/internal/app"
	"streamforge/internal/pipeline"
	"streamforge/internal/worker"
)

func main() {
	ctx, stop := app.SignalContext()
	defer stop()
	rt := app.New(ctx, "thumbnail-worker")
	app.ServeHealth(ctx, rt.Log)

	h := &pipeline.Thumbnail{Deps: rt.Deps, ProcessedBucket: app.MustEnv("PROCESSED_BUCKET")}
	c := &worker.Consumer{
		SQS: rt.SQS, QueueURL: app.MustEnv("THUMBNAIL_QUEUE_URL"), Log: rt.Log,
		Task: "thumbnail", Handle: h.Handle, OnGiveUp: rt.Deps.GiveUp("thumbnail"),
		Visibility: 120 * time.Second, HeartbeatInterval: 30 * time.Second,
		DrainTimeout: 20 * time.Second,
	}
	_ = c.Run(ctx)
	flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = rt.Shutdown(flush)
	rt.Log.Info("exited")
}
