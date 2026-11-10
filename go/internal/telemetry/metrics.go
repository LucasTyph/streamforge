package telemetry

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Registry is the process-wide Prometheus registry (Go runtime + process collectors included).
var Registry = func() *prometheus.Registry {
	r := prometheus.NewRegistry()
	r.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return r
}()

// Pipeline job metrics, labelled by task (probe|transcode|thumbnail).
var (
	JobsTotal = promauto(prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "streamforge_jobs_total",
		Help: "Messages handled by pipeline workers, by outcome (success|retry|failed|released).",
	}, []string{"task", "outcome"}))

	JobDuration = promauto(prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "streamforge_job_duration_seconds",
		Help:    "Wall time to handle one message, by outcome.",
		Buckets: []float64{0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300},
	}, []string{"task", "outcome"}))

	JobsInFlight = promauto(prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "streamforge_jobs_in_flight",
		Help: "Messages currently being handled.",
	}, []string{"task"}))
)

func promauto[T prometheus.Collector](c T) T {
	Registry.MustRegister(c)
	return c
}

// Handler serves /metrics.
func Handler() http.Handler {
	return promhttp.HandlerFor(Registry, promhttp.HandlerOpts{Registry: Registry})
}
