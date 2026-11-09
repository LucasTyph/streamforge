// Package worker is a small SQS consumer loop shared by all pipeline workers:
// long polling, visibility heartbeats, retry/backoff, give-up hooks before the DLQ,
// and graceful shutdown (stop polling, finish or release the in-flight message).
package worker

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// Message is what a handler sees.
type Message struct {
	Body         string
	ReceiveCount int // 1 on first delivery
	ID           string
}

// PermanentError means retrying cannot help: the message is deleted after OnGiveUp runs.
type PermanentError struct{ Err error }

func (e *PermanentError) Error() string { return e.Err.Error() }
func (e *PermanentError) Unwrap() error { return e.Err }

func Permanent(err error) error { return &PermanentError{err} }

// SQSAPI is the subset of the SQS client we use (faked in tests).
type SQSAPI interface {
	ReceiveMessage(context.Context, *sqs.ReceiveMessageInput, ...func(*sqs.Options)) (*sqs.ReceiveMessageOutput, error)
	DeleteMessage(context.Context, *sqs.DeleteMessageInput, ...func(*sqs.Options)) (*sqs.DeleteMessageOutput, error)
	ChangeMessageVisibility(context.Context, *sqs.ChangeMessageVisibilityInput, ...func(*sqs.Options)) (*sqs.ChangeMessageVisibilityOutput, error)
}

type Consumer struct {
	SQS      SQSAPI
	QueueURL string
	Log      *slog.Logger
	// Handle processes one message. nil => delete. PermanentError => OnGiveUp then delete.
	// Any other error => retry later; on the last allowed attempt OnGiveUp runs and the
	// message is left for SQS to move to the DLQ (so it can be redriven).
	Handle func(ctx context.Context, m Message) error
	// OnGiveUp reports a final failure (e.g. publishes a FAILED job status).
	OnGiveUp func(ctx context.Context, m Message, err error)

	MaxReceiveCount   int           // must match the queue's redrive policy (default 3)
	Visibility        time.Duration // extended on every heartbeat (default 60s)
	HeartbeatInterval time.Duration // default Visibility/3
	DrainTimeout      time.Duration // how long an in-flight message may run after SIGTERM (default 20s)
	RetryBackoff      time.Duration // visibility for a failed attempt, x attempt number (default 10s)
}

func (c *Consumer) defaults() {
	if c.MaxReceiveCount == 0 {
		c.MaxReceiveCount = 3
	}
	if c.Visibility == 0 {
		c.Visibility = 60 * time.Second
	}
	if c.HeartbeatInterval == 0 {
		c.HeartbeatInterval = c.Visibility / 3
	}
	if c.DrainTimeout == 0 {
		c.DrainTimeout = 20 * time.Second
	}
	if c.RetryBackoff == 0 {
		c.RetryBackoff = 10 * time.Second
	}
}

// Run polls until ctx is cancelled (SIGTERM), then lets the in-flight message finish
// within DrainTimeout; if it doesn't, the handler is cancelled and the message released.
func (c *Consumer) Run(ctx context.Context) error {
	c.defaults()
	c.Log.Info("consuming", "queue", c.QueueURL)
	for ctx.Err() == nil {
		out, err := c.SQS.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:                    &c.QueueURL,
			MaxNumberOfMessages:         1,
			WaitTimeSeconds:             20,
			VisibilityTimeout:           int32(c.Visibility.Seconds()),
			MessageSystemAttributeNames: []types.MessageSystemAttributeName{types.MessageSystemAttributeNameApproximateReceiveCount},
		})
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			c.Log.Warn("receive failed", "err", err)
			sleep(ctx, 2*time.Second)
			continue
		}
		for _, m := range out.Messages {
			c.process(ctx, m)
		}
	}
	c.Log.Info("stopped polling")
	return nil
}

func (c *Consumer) process(pollCtx context.Context, raw types.Message) {
	msg := Message{Body: aws.ToString(raw.Body), ID: aws.ToString(raw.MessageId), ReceiveCount: 1}
	if n, err := strconv.Atoi(raw.Attributes[string(types.MessageSystemAttributeNameApproximateReceiveCount)]); err == nil {
		msg.ReceiveCount = n
	}
	log := c.Log.With("messageId", msg.ID, "receiveCount", msg.ReceiveCount)
	// Independent of pollCtx so SIGTERM doesn't kill the job immediately.
	jobCtx, cancelJob := context.WithCancel(context.Background())
	defer cancelJob()
	stopDrain := context.AfterFunc(pollCtx, func() {
		log.Info("shutdown requested; draining in-flight message", "timeout", c.DrainTimeout)
		t := time.AfterFunc(c.DrainTimeout, cancelJob)
		context.AfterFunc(jobCtx, func() { t.Stop() })
	})
	defer stopDrain()

	hbDone := make(chan struct{})
	go c.heartbeat(jobCtx, raw.ReceiptHandle, log, hbDone)

	start := time.Now()
	err := c.Handle(jobCtx, msg)
	cancelJob()
	<-hbDone

	// Bookkeeping must work even during shutdown.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var perm *PermanentError
	switch {
	case err == nil:
		log.Info("message processed", "ms", time.Since(start).Milliseconds())
		c.delete(ctx, raw.ReceiptHandle, log)
	case errors.As(err, &perm):
		log.Warn("permanent failure", "err", err)
		if c.OnGiveUp != nil {
			c.OnGiveUp(ctx, msg, err)
		}
		c.delete(ctx, raw.ReceiptHandle, log)
	case pollCtx.Err() != nil:
		log.Info("released message for another worker", "err", err)
		c.setVisibility(ctx, raw.ReceiptHandle, 0, log)
	default:
		if msg.ReceiveCount >= c.MaxReceiveCount {
			log.Error("giving up; message will move to the DLQ", "err", err)
			if c.OnGiveUp != nil {
				c.OnGiveUp(ctx, msg, err)
			}
			c.setVisibility(ctx, raw.ReceiptHandle, 0, log)
			return
		}
		backoff := c.RetryBackoff * time.Duration(msg.ReceiveCount)
		log.Warn("attempt failed; will retry", "err", err, "retryIn", backoff)
		c.setVisibility(ctx, raw.ReceiptHandle, backoff, log)
	}
}

func (c *Consumer) heartbeat(ctx context.Context, receipt *string, log *slog.Logger, done chan<- struct{}) {
	defer close(done)
	t := time.NewTicker(c.HeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			hctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			c.setVisibility(hctx, receipt, c.Visibility, log)
			cancel()
		}
	}
}

func (c *Consumer) setVisibility(ctx context.Context, receipt *string, d time.Duration, log *slog.Logger) {
	if _, err := c.SQS.ChangeMessageVisibility(ctx, &sqs.ChangeMessageVisibilityInput{
		QueueUrl: &c.QueueURL, ReceiptHandle: receipt, VisibilityTimeout: int32(d.Seconds()),
	}); err != nil {
		log.Warn("change visibility failed", "err", err)
	}
}

func (c *Consumer) delete(ctx context.Context, receipt *string, log *slog.Logger) {
	if _, err := c.SQS.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: &c.QueueURL, ReceiptHandle: receipt}); err != nil {
		log.Error("delete failed; message will be redelivered", "err", err)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
