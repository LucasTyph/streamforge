// Package app wires config, logging, AWS clients and shutdown for worker binaries.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/redis/go-redis/v9"

	"streamforge/internal/events"
	"streamforge/internal/pipeline"
	"streamforge/internal/progress"
	"streamforge/internal/storage"
	"streamforge/internal/telemetry"
)

func Env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func MustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintf(os.Stderr, "missing required env %s\n", k)
		os.Exit(2)
	}
	return v
}

// Runtime holds the shared clients for a worker process.
type Runtime struct {
	Log      *slog.Logger
	Shutdown func(context.Context) error // flushes traces
	AWS      aws.Config
	SQS      *sqs.Client
	Deps     pipeline.Deps
}

// New loads AWS config (honouring AWS_ENDPOINT_URL_<SERVICE>) and builds shared deps.
func New(ctx context.Context, service string) *Runtime {
	log := telemetry.NewLogger(service)
	shutdown := telemetry.Setup(ctx, service)
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Error("aws config", "err", err)
		os.Exit(1)
	}
	cfg.RetryMaxAttempts = 3
	var rep progress.Reporter = progress.Nop{}
	if url := os.Getenv("REDIS_URL"); url != "" {
		opt, err := redis.ParseURL(url)
		if err != nil {
			log.Error("redis url", "err", err)
			os.Exit(1)
		}
		opt.DialTimeout, opt.ReadTimeout, opt.WriteTimeout = 2*time.Second, time.Second, time.Second
		rep = &progress.Redis{Client: redis.NewClient(opt), Log: log, MinInterval: 500 * time.Millisecond}
	}
	return &Runtime{
		Log: log, Shutdown: shutdown, AWS: cfg, SQS: sqs.NewFromConfig(cfg),
		Deps: pipeline.Deps{
			Store:          storage.New(cfg),
			Pub:            events.SNSPublisher{Client: sns.NewFromConfig(cfg)},
			Progress:       rep,
			Log:            log,
			JobStatusTopic: MustEnv("JOB_STATUS_TOPIC_ARN"),
			TmpDir:         os.Getenv("WORK_DIR"),
		},
	}
}

// SignalContext is cancelled on SIGTERM/SIGINT.
func SignalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
}

// ServeHealth exposes /healthz and /readyz on HEALTH_PORT (default 8080). readyz turns
// 503 once shutdown starts so Kubernetes stops routing to the pod.
func ServeHealth(ctx context.Context, log *slog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.Handle("/metrics", telemetry.Handler())
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if ctx.Err() != nil {
			http.Error(w, "shutting down", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})
	srv := &http.Server{Addr: ":" + Env("HEALTH_PORT", "8080"), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("health server", "err", err)
		}
	}()
}
