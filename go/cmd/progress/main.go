// Command progress (progress-svc) streams live pipeline progress to browsers over
// Server-Sent Events. Env: PORT (4001), REDIS_URL, JWT_SECRET, WEB_ORIGIN, SESSION_COOKIE.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"

	"streamforge/internal/app"
	"streamforge/internal/sse"
	"streamforge/internal/telemetry"
)

func main() {
	log := telemetry.NewLogger("progress-svc")
	ctx, stop := app.SignalContext()
	defer stop()

	opt, err := redis.ParseURL(app.MustEnv("REDIS_URL"))
	if err != nil {
		log.Error("redis url", "err", err)
		os.Exit(1)
	}
	opt.DialTimeout = 2 * time.Second
	rdb := redis.NewClient(opt)

	hub := sse.NewHub()
	telemetry.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "streamforge_sse_clients", Help: "Connected Server-Sent Events clients.",
	}, func() float64 { return float64(hub.Clients()) }))
	go func() { // one pattern subscription for the whole process; reconnects automatically
		ps := rdb.PSubscribe(context.Background(), "progress:user:*")
		defer ps.Close()
		for m := range ps.Channel() {
			hub.Route(m.Channel, []byte(m.Payload))
		}
	}()

	var shuttingDown atomic.Bool
	s := &sse.Server{
		Hub: hub, Secret: []byte(app.MustEnv("JWT_SECRET")), CookieName: app.Env("SESSION_COOKIE", "sf_session"),
		AllowOrigin: os.Getenv("WEB_ORIGIN"), Heartbeat: 15 * time.Second, Log: log,
		ShuttingDown: shuttingDown.Load,
	}
	// No WriteTimeout: SSE responses are long-lived by design.
	srv := &http.Server{Addr: ":" + app.Env("PORT", "4001"), Handler: s.Routes(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		log.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("serve", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shuttingDown.Store(true) // readyz -> 503; streams close on their next heartbeat
	log.Info("shutting down", "clients", hub.Clients())
	sctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
	_ = rdb.Close()
}
