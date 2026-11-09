package worker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

type fakeSQS struct {
	mu         sync.Mutex
	pending    []types.Message
	deleted    int
	visibility []int32
}

func (f *fakeSQS) ReceiveMessage(ctx context.Context, _ *sqs.ReceiveMessageInput, _ ...func(*sqs.Options)) (*sqs.ReceiveMessageOutput, error) {
	f.mu.Lock()
	if len(f.pending) > 0 {
		m := f.pending[0]
		f.pending = f.pending[1:]
		f.mu.Unlock()
		return &sqs.ReceiveMessageOutput{Messages: []types.Message{m}}, nil
	}
	f.mu.Unlock()
	<-ctx.Done()
	return nil, ctx.Err()
}

func (f *fakeSQS) DeleteMessage(context.Context, *sqs.DeleteMessageInput, ...func(*sqs.Options)) (*sqs.DeleteMessageOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted++
	return &sqs.DeleteMessageOutput{}, nil
}

func (f *fakeSQS) ChangeMessageVisibility(_ context.Context, in *sqs.ChangeMessageVisibilityInput, _ ...func(*sqs.Options)) (*sqs.ChangeMessageVisibilityOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.visibility = append(f.visibility, in.VisibilityTimeout)
	return &sqs.ChangeMessageVisibilityOutput{}, nil
}

func msg(receiveCount int) types.Message {
	return types.Message{
		Body: aws.String(`{}`), MessageId: aws.String("m1"), ReceiptHandle: aws.String("r1"),
		Attributes: map[string]string{"ApproximateReceiveCount": strconv.Itoa(receiveCount)},
	}
}

// runOne processes a single message, then stops the consumer.
func runOne(t *testing.T, f *fakeSQS, c *Consumer, stopAfter time.Duration) {
	t.Helper()
	c.SQS, c.QueueURL = f, "q"
	c.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithTimeout(context.Background(), stopAfter)
	defer cancel()
	_ = c.Run(ctx)
}

func TestSuccessDeletes(t *testing.T) {
	f := &fakeSQS{pending: []types.Message{msg(1)}}
	runOne(t, f, &Consumer{Handle: func(context.Context, Message) error { return nil }}, 50*time.Millisecond)
	if f.deleted != 1 {
		t.Fatalf("deleted = %d, want 1", f.deleted)
	}
}

func TestTransientFailureBacksOffWithoutGivingUp(t *testing.T) {
	f := &fakeSQS{pending: []types.Message{msg(2)}}
	gaveUp := false
	runOne(t, f, &Consumer{
		Handle:       func(context.Context, Message) error { return errors.New("s3 timeout") },
		OnGiveUp:     func(context.Context, Message, error) { gaveUp = true },
		RetryBackoff: 10 * time.Second,
	}, 50*time.Millisecond)
	if f.deleted != 0 || gaveUp {
		t.Fatalf("deleted=%d gaveUp=%v, want 0/false", f.deleted, gaveUp)
	}
	if len(f.visibility) != 1 || f.visibility[0] != 20 {
		t.Fatalf("visibility = %v, want [20] (10s x attempt 2)", f.visibility)
	}
}

func TestLastAttemptGivesUpAndLeavesMessageForDLQ(t *testing.T) {
	f := &fakeSQS{pending: []types.Message{msg(3)}}
	var reported error
	runOne(t, f, &Consumer{
		Handle:   func(context.Context, Message) error { return errors.New("boom") },
		OnGiveUp: func(_ context.Context, _ Message, err error) { reported = err },
	}, 50*time.Millisecond)
	if reported == nil || f.deleted != 0 {
		t.Fatalf("reported=%v deleted=%d; want report and no delete (SQS moves it to the DLQ)", reported, f.deleted)
	}
}

func TestPermanentFailureReportsAndDeletes(t *testing.T) {
	f := &fakeSQS{pending: []types.Message{msg(1)}}
	gaveUp := false
	runOne(t, f, &Consumer{
		Handle:   func(context.Context, Message) error { return Permanent(errors.New("not a video")) },
		OnGiveUp: func(context.Context, Message, error) { gaveUp = true },
	}, 50*time.Millisecond)
	if !gaveUp || f.deleted != 1 {
		t.Fatalf("gaveUp=%v deleted=%d, want true/1", gaveUp, f.deleted)
	}
}

func TestShutdownReleasesSlowMessage(t *testing.T) {
	f := &fakeSQS{pending: []types.Message{msg(1)}}
	runOne(t, f, &Consumer{
		Handle: func(ctx context.Context, _ Message) error {
			<-ctx.Done() // a long transcode that only stops when cancelled
			return ctx.Err()
		},
		DrainTimeout: 20 * time.Millisecond,
	}, 30*time.Millisecond)
	if f.deleted != 0 || len(f.visibility) == 0 || f.visibility[len(f.visibility)-1] != 0 {
		t.Fatalf("deleted=%d visibility=%v; want message released (visibility 0)", f.deleted, f.visibility)
	}
}

func TestShutdownLetsFastMessageFinish(t *testing.T) {
	f := &fakeSQS{pending: []types.Message{msg(1)}}
	runOne(t, f, &Consumer{
		Handle: func(ctx context.Context, _ Message) error {
			time.Sleep(40 * time.Millisecond) // finishes after SIGTERM but within the drain timeout
			return nil
		},
		DrainTimeout: time.Second,
	}, 10*time.Millisecond)
	if f.deleted != 1 {
		t.Fatalf("deleted = %d, want 1", f.deleted)
	}
}

func TestHeartbeatExtendsVisibility(t *testing.T) {
	f := &fakeSQS{pending: []types.Message{msg(1)}}
	runOne(t, f, &Consumer{
		Handle:            func(context.Context, Message) error { time.Sleep(55 * time.Millisecond); return nil },
		Visibility:        2 * time.Minute,
		HeartbeatInterval: 10 * time.Millisecond,
	}, 80*time.Millisecond)
	if len(f.visibility) < 3 || f.visibility[0] != 120 {
		t.Fatalf("visibility = %v, want several 120s heartbeats", f.visibility)
	}
}
