package sse

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var secret = []byte("test-secret-at-least-32-characters!!")

func sign(t *testing.T, alg string, claims map[string]any, key []byte) string {
	t.Helper()
	enc := base64.RawURLEncoding
	h, _ := json.Marshal(map[string]string{"alg": alg, "typ": "JWT"})
	p, _ := json.Marshal(claims)
	unsigned := enc.EncodeToString(h) + "." + enc.EncodeToString(p)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(unsigned))
	return unsigned + "." + enc.EncodeToString(mac.Sum(nil))
}

func TestVerifyHS256(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	good := map[string]any{"sub": "u1", "email": "a@b.c", "exp": now.Add(time.Hour).Unix()}
	if c, err := VerifyHS256(sign(t, "HS256", good, secret), secret, now); err != nil || c.Sub != "u1" {
		t.Fatalf("valid token rejected: %v", err)
	}
	expired := map[string]any{"sub": "u1", "exp": now.Add(-time.Second).Unix()}
	for name, tok := range map[string]string{
		"expired":   sign(t, "HS256", expired, secret),
		"wrong key": sign(t, "HS256", good, []byte("another-secret-of-sufficient-length!!")),
		"alg none":  strings.TrimSuffix(sign(t, "none", good, secret), "x") + "",
		"garbage":   "a.b.c",
		"no sub":    sign(t, "HS256", map[string]any{"exp": now.Add(time.Hour).Unix()}, secret),
	} {
		if _, err := VerifyHS256(tok, secret, now); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestHubRoutesOnlyToOwner(t *testing.T) {
	h := NewHub()
	a, unsubA := h.Subscribe("alice")
	b, unsubB := h.Subscribe("bob")
	defer unsubB()
	h.Route("progress:user:alice", []byte("for-alice"))
	h.Route("other-channel", []byte("ignored"))
	if got := string(<-a); got != "for-alice" {
		t.Fatalf("alice got %q", got)
	}
	select {
	case m := <-b:
		t.Fatalf("bob received %q", m)
	default:
	}
	unsubA()
	if h.Clients() != 1 {
		t.Fatalf("clients = %d, want 1", h.Clients())
	}
}

func TestHubNeverBlocksOnSlowClient(t *testing.T) {
	h := NewHub()
	_, unsub := h.Subscribe("slow")
	defer unsub()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			h.Publish("slow", []byte("x"))
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a slow subscriber")
	}
}

func TestEventsEndpoint(t *testing.T) {
	h := NewHub()
	s := &Server{Hub: h, Secret: secret, CookieName: "sf_session", AllowOrigin: "http://localhost:3000",
		Heartbeat: time.Hour, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	srv := httptest.NewServer(s.Routes())
	defer srv.Close()

	res, err := http.Get(srv.URL + "/events")
	if err != nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no cookie: status %v err %v", res.StatusCode, err)
	}

	tok := sign(t, "HS256", map[string]any{"sub": "u1", "exp": time.Now().Add(time.Hour).Unix()}, secret)
	req, _ := http.NewRequest("GET", srv.URL+"/events", nil)
	req.AddCookie(&http.Cookie{Name: "sf_session", Value: tok})
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Content-Type") != "text/event-stream" || res.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("headers: %v", res.Header)
	}
	r := bufio.NewReader(res.Body)
	readEvent := func() string {
		var lines []string
		for {
			l, err := r.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if l == "\n" {
				return strings.Join(lines, "")
			}
			lines = append(lines, l)
		}
	}
	if hello := readEvent(); !strings.Contains(hello, "event: hello") {
		t.Fatalf("first event = %q", hello)
	}
	for h.Clients() == 0 {
		time.Sleep(time.Millisecond)
	}
	h.Route("progress:user:u1", []byte(`{"kind":"progress","percent":42}`))
	if ev := readEvent(); ev != "data: {\"kind\":\"progress\",\"percent\":42}\n" {
		t.Fatalf("event = %q", ev)
	}
}
