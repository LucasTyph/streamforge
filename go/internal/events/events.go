// Package events defines the messages exchanged over SNS/SQS and a publisher.
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sns/types"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"streamforge/internal/telemetry"
)

// VideoUploaded is published by catalog-api when an upload completes.
type VideoUploaded struct {
	Type        string `json:"type"`
	VideoID     string `json:"videoId"`
	OwnerID     string `json:"ownerId"` // routes live progress to the owner's SSE stream
	Bucket      string `json:"bucket"`
	Key         string `json:"key"`
	SizeBytes   int64  `json:"sizeBytes"`
	ContentType string `json:"contentType"`
}

// Rendition is one HLS output variant.
type Rendition struct {
	Name         string `json:"name"` // e.g. "720p"
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	VideoBitrate int    `json:"videoBitrateKbps"`
}

// VideoProbed is published by probe-worker after a successful probe.
type VideoProbed struct {
	Type            string      `json:"type"`
	VideoID         string      `json:"videoId"`
	OwnerID         string      `json:"ownerId"`
	Bucket          string      `json:"bucket"`
	Key             string      `json:"key"`
	DurationSeconds float64     `json:"durationSeconds"`
	Width           int         `json:"width"`
	Height          int         `json:"height"`
	HasAudio        bool        `json:"hasAudio"`
	Renditions      []Rendition `json:"renditions"`
}

type JobState string

const (
	Running   JobState = "RUNNING"
	Succeeded JobState = "SUCCEEDED"
	Failed    JobState = "FAILED"
)

// JobStatus is published by every worker; catalog-api applies it to the jobs table.
type JobStatus struct {
	Type    string         `json:"type"`
	VideoID string         `json:"videoId"`
	Task    string         `json:"task"` // probe | transcode | thumbnail
	State   JobState       `json:"state"`
	Attempt int            `json:"attempt"`
	Error   string         `json:"error,omitempty"`
	Result  map[string]any `json:"result,omitempty"`
	At      time.Time      `json:"at"`
}

// Publisher publishes JSON events to SNS topics.
type Publisher interface {
	Publish(ctx context.Context, topicArn string, v any) error
}

type SNSPublisher struct{ Client *sns.Client }

func (p SNSPublisher) Publish(ctx context.Context, topicArn string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	typ := fmt.Sprintf("%T", v)
	ctx, span := telemetry.Tracer("events").Start(ctx, "publish "+topicName(topicArn), trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(attribute.String("messaging.system", "aws_sns"), attribute.String("messaging.destination.name", topicName(topicArn))))
	defer span.End()
	attrs := map[string]types.MessageAttributeValue{"type": {DataType: aws.String("String"), StringValue: &typ}}
	for k, v := range telemetry.Inject(ctx) { // traceparent: consumers continue this trace
		attrs[k] = types.MessageAttributeValue{DataType: aws.String("String"), StringValue: aws.String(v)}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err = p.Client.Publish(ctx, &sns.PublishInput{TopicArn: &topicArn, Message: aws.String(string(b)), MessageAttributes: attrs})
	if err != nil {
		span.RecordError(err)
	}
	return err
}

func topicName(arn string) string {
	for i := len(arn) - 1; i >= 0; i-- {
		if arn[i] == ':' {
			return arn[i+1:]
		}
	}
	return arn
}
