// Command sns-shim runs a minimal SNS emulator that fans out to SQS.
// Config (env): PORT, STATE_FILE, AWS_REGION, AWS_ACCOUNT_ID, AWS_ENDPOINT_URL_SQS + AWS creds.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"

	"streamforge/internal/snsshim"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "sns-shim")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := config.LoadDefaultConfig(ctx) // honours AWS_ENDPOINT_URL_SQS
	if err != nil {
		log.Error("aws config", "err", err)
		os.Exit(1)
	}
	srv, err := snsshim.New(env("STATE_FILE", ""), cfg.Region, env("AWS_ACCOUNT_ID", "000000000000"),
		&snsshim.SQSSender{Client: sqs.NewFromConfig(cfg)}, log)
	if err != nil {
		log.Error("init", "err", err)
		os.Exit(1)
	}

	hs := &http.Server{Addr: ":" + env("PORT", "9911"), Handler: srv,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second}
	go func() {
		log.Info("listening", "addr", hs.Addr)
		if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("serve", "err", err)
			os.Exit(1)
		}
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = hs.Shutdown(shutdownCtx)
	log.Info("stopped")
}
