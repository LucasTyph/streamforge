//go:build integration

// Integration tests with Testcontainers: real ffmpeg/ffprobe, SeaweedFS (S3) and
// ElasticMQ (SQS). Run: make test-go-integration (needs Docker and ffmpeg on PATH).
package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"streamforge/internal/events"
	"streamforge/internal/progress"
	"streamforge/internal/storage"
	"streamforge/internal/worker"
)

const (
	rawBucket       = "it-raw"
	processedBucket = "it-processed"
)

type published struct {
	topic string
	body  []byte
}

type fakePub struct {
	mu   sync.Mutex
	msgs []published
}

func (f *fakePub) Publish(_ context.Context, topic string, v any) error {
	b, _ := json.Marshal(v)
	f.mu.Lock()
	f.msgs = append(f.msgs, published{topic, b})
	f.mu.Unlock()
	return nil
}

func (f *fakePub) statuses() []events.JobStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []events.JobStatus
	for _, m := range f.msgs {
		if m.topic == "status" {
			var s events.JobStatus
			json.Unmarshal(m.body, &s)
			out = append(out, s)
		}
	}
	return out
}

func (f *fakePub) reset() { f.mu.Lock(); f.msgs = nil; f.mu.Unlock() }

func awsCfg(endpoint string) aws.Config {
	return aws.Config{
		Region:       "us-east-1",
		Credentials:  credentials.NewStaticCredentialsProvider("test", "test", ""),
		BaseEndpoint: aws.String(endpoint),
	}
}

func start(t *testing.T, req testcontainers.ContainerRequest, port string) string {
	t.Helper()
	ctx := context.Background()
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{ContainerRequest: req, Started: true})
	if err != nil {
		t.Fatalf("start %s: %v", req.Image, err)
	}
	t.Cleanup(func() { _ = c.Terminate(context.Background()) })
	ep, err := c.PortEndpoint(ctx, port, "http")
	if err != nil {
		t.Fatal(err)
	}
	return ep
}

func seaweed(t *testing.T) *storage.S3 {
	ep := start(t, testcontainers.ContainerRequest{
		Image:        "chrislusf/seaweedfs:4.53",
		Cmd:          []string{"server", "-s3", "-dir=/data", "-volume.max=0", "-master.volumeSizeLimitMB=64"},
		ExposedPorts: []string{"8333/tcp"},
		WaitingFor:   wait.ForListeningPort("8333/tcp").WithStartupTimeout(90 * time.Second),
	}, "8333/tcp")
	st := storage.New(awsCfg(ep))
	deadline := time.Now().Add(60 * time.Second)
	for _, b := range []string{rawBucket, processedBucket} {
		for {
			_, err := st.Client.CreateBucket(context.Background(), &s3.CreateBucketInput{Bucket: aws.String(b)})
			if err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("create bucket %s: %v", b, err)
			}
			time.Sleep(500 * time.Millisecond) // filer still starting
		}
	}
	return st
}

func deps(st *storage.S3, pub *fakePub) Deps {
	return Deps{
		Store: st, Pub: pub, Progress: progress.Nop{},
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		JobStatusTopic: "status",
	}
}

func genClip(t *testing.T, size string, seconds string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "clip.mp4")
	out, err := exec.Command("ffmpeg", "-nostdin", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size="+size+":rate=30:duration="+seconds,
		"-f", "lavfi", "-i", "sine=frequency=440:duration="+seconds,
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p).CombinedOutput()
	if err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	return p
}

func upload(t *testing.T, st *storage.S3, key, path string) {
	t.Helper()
	if err := st.Put(context.Background(), rawBucket, key, path); err != nil {
		t.Fatal(err)
	}
}

func listKeys(t *testing.T, st *storage.S3, prefix string) map[string]string {
	t.Helper()
	out, err := st.Client.ListObjectsV2(context.Background(), &s3.ListObjectsV2Input{Bucket: aws.String(processedBucket), Prefix: aws.String(prefix)})
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]string{}
	for _, o := range out.Contents {
		keys[*o.Key] = o.LastModified.String() + "/" + aws.ToString(o.ETag)
	}
	return keys
}

func msgOf(t *testing.T, v any, receiveCount int) worker.Message {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return worker.Message{Body: string(b), ReceiveCount: receiveCount}
}

func TestProbeTranscodeAndRedelivery(t *testing.T) {
	st := seaweed(t)
	pub := &fakePub{}
	d := deps(st, pub)
	ctx := context.Background()
	videoID := "11111111-1111-4111-8111-111111111111"
	upload(t, st, "uploads/"+videoID+"/source", genClip(t, "1280x720", "6"))

	// probe
	probe := &Probe{Deps: d, VideoProbedTopic: "probed"}
	up := events.VideoUploaded{VideoID: videoID, Bucket: rawBucket, Key: "uploads/" + videoID + "/source"}
	if err := probe.Handle(ctx, msgOf(t, up, 1)); err != nil {
		t.Fatalf("probe: %v", err)
	}
	var probed events.VideoProbed
	for _, m := range pub.msgs {
		if m.topic == "probed" {
			json.Unmarshal(m.body, &probed)
		}
	}
	if probed.Width != 1280 || !probed.HasAudio || len(probed.Renditions) != 2 || probed.DurationSeconds < 5.9 {
		t.Fatalf("unexpected probe result: %+v", probed)
	}

	// transcode
	tc := &Transcode{Deps: d, ProcessedBucket: processedBucket}
	pub.reset()
	if err := tc.Handle(ctx, msgOf(t, probed, 1)); err != nil {
		t.Fatalf("transcode: %v", err)
	}
	states := pub.statuses()
	if len(states) != 2 || states[0].State != events.Running || states[1].State != events.Succeeded {
		t.Fatalf("statuses = %+v", states)
	}
	before := listKeys(t, st, videoID+"/hls/")
	for _, k := range []string{"master.m3u8", "360p/index.m3u8", "720p/index.m3u8", "720p/seg_000.ts"} {
		if _, ok := before[videoID+"/hls/"+k]; !ok {
			t.Errorf("missing output %s (have %d objects)", k, len(before))
		}
	}

	// redelivery: the same message again must not redo work or touch outputs
	pub.reset()
	if err := tc.Handle(ctx, msgOf(t, probed, 2)); err != nil {
		t.Fatalf("redelivered transcode: %v", err)
	}
	states = pub.statuses()
	if len(states) != 1 || states[0].State != events.Succeeded || states[0].Attempt != 2 {
		t.Fatalf("redelivery statuses = %+v, want a single SUCCEEDED", states)
	}
	after := listKeys(t, st, videoID+"/hls/")
	if len(after) != len(before) {
		t.Fatalf("object count changed on redelivery: %d -> %d", len(before), len(after))
	}
	for k, v := range before {
		if after[k] != v {
			t.Errorf("object %s was rewritten on redelivery", k)
		}
	}
}

func TestCorruptUploadFailsWithReason(t *testing.T) {
	st := seaweed(t)
	pub := &fakePub{}
	d := deps(st, pub)
	videoID := "22222222-2222-4222-8222-222222222222"
	junk := filepath.Join(t.TempDir(), "corrupt.mp4")
	os.WriteFile(junk, bytes.Repeat([]byte("x"), 200_000), 0o644)
	upload(t, st, "uploads/"+videoID+"/source", junk)

	probe := &Probe{Deps: d, VideoProbedTopic: "probed"}
	m := msgOf(t, events.VideoUploaded{VideoID: videoID, Bucket: rawBucket, Key: "uploads/" + videoID + "/source"}, 1)
	err := probe.Handle(context.Background(), m)
	var perm *worker.PermanentError
	if !errors.As(err, &perm) {
		t.Fatalf("want PermanentError, got %v", err)
	}
	d.GiveUp("probe")(context.Background(), m, err)
	states := pub.statuses()
	last := states[len(states)-1]
	if last.State != events.Failed || last.Error != "The file is not a readable video" {
		t.Fatalf("final status = %+v", last)
	}
}

func TestFailingMessageEndsInDLQ(t *testing.T) {
	ep := start(t, testcontainers.ContainerRequest{
		Image:        "softwaremill/elasticmq-native:1.7.1",
		ExposedPorts: []string{"9324/tcp"},
		WaitingFor:   wait.ForListeningPort("9324/tcp").WithStartupTimeout(60 * time.Second),
	}, "9324/tcp")
	ctx := context.Background()
	client := sqs.NewFromConfig(awsCfg(ep))
	dlq, err := client.CreateQueue(ctx, &sqs.CreateQueueInput{QueueName: aws.String("it-dlq")})
	if err != nil {
		t.Fatal(err)
	}
	attrs, _ := client.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{QueueUrl: dlq.QueueUrl, AttributeNames: []sqstypes.QueueAttributeName{sqstypes.QueueAttributeNameQueueArn}})
	q, err := client.CreateQueue(ctx, &sqs.CreateQueueInput{QueueName: aws.String("it-q"), Attributes: map[string]string{
		"RedrivePolicy": `{"deadLetterTargetArn":"` + attrs.Attributes["QueueArn"] + `","maxReceiveCount":"3"}`,
	}})
	if err != nil {
		t.Fatal(err)
	}
	client.SendMessage(ctx, &sqs.SendMessageInput{QueueUrl: q.QueueUrl, MessageBody: aws.String(`{"videoId":"v"}`)})

	var calls, gaveUp atomic.Int32
	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	c := &worker.Consumer{
		SQS: client, QueueURL: *q.QueueUrl, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Handle: func(context.Context, worker.Message) error { calls.Add(1); return errors.New("always fails") },
		OnGiveUp: func(context.Context, worker.Message, error) {
			gaveUp.Add(1)
		},
		RetryBackoff: time.Second,
	}
	go c.Run(runCtx)

	for runCtx.Err() == nil {
		out, err := client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{QueueUrl: dlq.QueueUrl, WaitTimeSeconds: 1})
		if err == nil && len(out.Messages) == 1 {
			cancel()
			if calls.Load() != 3 || gaveUp.Load() != 1 {
				t.Fatalf("handler calls=%d gaveUp=%d, want 3 and 1", calls.Load(), gaveUp.Load())
			}
			return
		}
	}
	t.Fatalf("message never reached the DLQ (calls=%d)", calls.Load())
}
