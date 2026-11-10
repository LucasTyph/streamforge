// Package telemetry sets up OpenTelemetry tracing, trace-aware JSON logs, Prometheus
// metrics, and trace-context propagation through SNS/SQS message attributes.
package telemetry

import (
	"context"
	"log/slog"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// Setup installs the global tracer provider and W3C propagator. Spans are exported over
// OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set (the SDK reads the standard OTEL_*
// variables); otherwise tracing stays in-process and costs almost nothing.
func Setup(ctx context.Context, service string) (shutdown func(context.Context) error) {
	otel.SetTextMapPropagator(propagation.TraceContext{})
	res, _ := resource.Merge(resource.Default(), resource.NewSchemaless(semconv.ServiceName(service)))
	opts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res), sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.AlwaysSample()))}
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != "" {
		if exp, err := otlptracehttp.New(ctx); err == nil {
			opts = append(opts, sdktrace.WithBatcher(exp, sdktrace.WithBatchTimeout(2*time.Second)))
		}
	}
	tp := sdktrace.NewTracerProvider(opts...)
	otel.SetTracerProvider(tp)
	return tp.Shutdown
}

// Tracer returns the named tracer from the global provider.
func Tracer(name string) trace.Tracer { return otel.Tracer("streamforge/" + name) }

// Inject writes the current trace context into a string map (message attributes).
func Inject(ctx context.Context) map[string]string {
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	return carrier
}

// Extract returns ctx with the remote trace context from message attributes, if any.
func Extract(ctx context.Context, attrs map[string]string) context.Context {
	return otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(attrs))
}

// ---- logs -------------------------------------------------------------------

// NewLogger returns a JSON slog logger that adds trace_id/span_id from the context, so
// logs and traces link to each other in Grafana. Use the *Context logging methods.
func NewLogger(service string) *slog.Logger {
	return slog.New(traceHandler{slog.NewJSONHandler(os.Stdout, nil)}).With("service", service)
}

type traceHandler struct{ slog.Handler }

func (h traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h traceHandler) WithAttrs(a []slog.Attr) slog.Handler {
	return traceHandler{h.Handler.WithAttrs(a)}
}
func (h traceHandler) WithGroup(n string) slog.Handler { return traceHandler{h.Handler.WithGroup(n)} }
