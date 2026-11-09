package snsshim

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

type sent struct {
	queue, body string
	attrs       map[string]Attr
}

type fakeSender struct{ msgs []sent }

func (f *fakeSender) Send(_ context.Context, q, b string, a map[string]Attr) error {
	f.msgs = append(f.msgs, sent{q, b, a})
	return nil
}

func call(t *testing.T, s *Server, v url.Values) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(v.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	b, _ := io.ReadAll(rec.Body)
	return rec.Code, string(b)
}

func newServer(t *testing.T, path string, fs *fakeSender) *Server {
	t.Helper()
	s, err := New(path, "us-east-1", "000000000000", fs, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

const topic = "arn:aws:sns:us-east-1:000000000000:video-uploaded"

func TestFanOutRawAndEnvelope(t *testing.T) {
	fs := &fakeSender{}
	s := newServer(t, "", fs)

	if code, body := call(t, s, url.Values{"Action": {"CreateTopic"}, "Name": {"video-uploaded"}}); code != 200 || !strings.Contains(body, topic) {
		t.Fatalf("CreateTopic: %d %s", code, body)
	}
	call(t, s, url.Values{"Action": {"Subscribe"}, "TopicArn": {topic}, "Protocol": {"sqs"},
		"Endpoint":               {"arn:aws:sqs:us-east-1:000000000000:raw-q"},
		"Attributes.entry.1.key": {"RawMessageDelivery"}, "Attributes.entry.1.value": {"true"}})
	call(t, s, url.Values{"Action": {"Subscribe"}, "TopicArn": {topic}, "Protocol": {"sqs"},
		"Endpoint": {"arn:aws:sqs:us-east-1:000000000000:env-q"}})

	code, body := call(t, s, url.Values{"Action": {"Publish"}, "TopicArn": {topic}, "Message": {`{"videoId":"v1"}`},
		"MessageAttributes.entry.1.Name": {"traceparent"}, "MessageAttributes.entry.1.Value.DataType": {"String"},
		"MessageAttributes.entry.1.Value.StringValue": {"00-abc-def-01"}})
	if code != 200 || !strings.Contains(body, "<MessageId>") {
		t.Fatalf("Publish: %d %s", code, body)
	}
	if len(fs.msgs) != 2 {
		t.Fatalf("want 2 deliveries, got %d", len(fs.msgs))
	}
	for _, m := range fs.msgs {
		if m.attrs["traceparent"].StringValue != "00-abc-def-01" {
			t.Errorf("%s: attributes not forwarded", m.queue)
		}
		switch {
		case strings.HasSuffix(m.queue, "raw-q"):
			if m.body != `{"videoId":"v1"}` {
				t.Errorf("raw body = %s", m.body)
			}
		default:
			var env map[string]any
			if err := json.Unmarshal([]byte(m.body), &env); err != nil || env["Message"] != `{"videoId":"v1"}` || env["Type"] != "Notification" {
				t.Errorf("envelope body = %s", m.body)
			}
		}
	}
}

func TestSubscribeIsIdempotentAndStatePersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s := newServer(t, path, &fakeSender{})
	call(t, s, url.Values{"Action": {"CreateTopic"}, "Name": {"video-uploaded"}})
	sub := url.Values{"Action": {"Subscribe"}, "TopicArn": {topic}, "Protocol": {"sqs"}, "Endpoint": {"arn:aws:sqs:us-east-1:000000000000:q"}}
	_, a := call(t, s, sub)
	_, b := call(t, s, sub)
	arnA, arnB := between(a, "<SubscriptionArn>", "</SubscriptionArn>"), between(b, "<SubscriptionArn>", "</SubscriptionArn>")
	if arnA == "" || arnA != arnB {
		t.Fatalf("subscribe not idempotent:\n%s\n%s", a, b)
	}

	reloaded := newServer(t, path, &fakeSender{})
	_, list := call(t, reloaded, url.Values{"Action": {"ListSubscriptionsByTopic"}, "TopicArn": {topic}})
	if strings.Count(list, "<member>") != 1 {
		t.Fatalf("want 1 subscription after reload, got: %s", list)
	}
}

func TestErrors(t *testing.T) {
	s := newServer(t, "", &fakeSender{})
	if code, body := call(t, s, url.Values{"Action": {"Publish"}, "TopicArn": {topic}, "Message": {"x"}}); code != 404 || !strings.Contains(body, "NotFound") {
		t.Fatalf("publish to missing topic: %d %s", code, body)
	}
	if code, _ := call(t, s, url.Values{"Action": {"Bogus"}}); code != 400 {
		t.Fatalf("unknown action: %d", code)
	}
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	j := strings.Index(s, b)
	if i < 0 || j < i {
		return ""
	}
	return s[i+len(a) : j]
}
