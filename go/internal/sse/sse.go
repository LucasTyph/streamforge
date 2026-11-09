// Package sse implements progress-svc: it authenticates browsers with the catalog-api
// session cookie (HS256 JWT), subscribes once to Redis "progress:user:*", and fans
// each user's events out to that user's Server-Sent Events connections.
package sse

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---- auth -------------------------------------------------------------------

type Claims struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Exp   int64  `json:"exp"`
}

var ErrUnauthorized = errors.New("unauthorized")

// VerifyHS256 validates a compact JWT signed with HMAC-SHA256 and returns its claims.
func VerifyHS256(token string, secret []byte, now time.Time) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, ErrUnauthorized
	}
	var hdr struct{ Alg, Typ string }
	if b, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil || json.Unmarshal(b, &hdr) != nil || hdr.Alg != "HS256" {
		return Claims{}, ErrUnauthorized // also rejects alg=none
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return Claims{}, ErrUnauthorized
	}
	var c Claims
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(b, &c) != nil || c.Sub == "" || c.Exp == 0 || now.Unix() >= c.Exp {
		return Claims{}, ErrUnauthorized
	}
	return c, nil
}

// ---- hub --------------------------------------------------------------------

// Hub routes payloads to the subscribers of one user.
type Hub struct {
	mu      sync.RWMutex
	subs    map[string]map[chan []byte]struct{}
	clients atomic.Int64
	dropped atomic.Int64
}

func NewHub() *Hub { return &Hub{subs: map[string]map[chan []byte]struct{}{}} }

func (h *Hub) Subscribe(user string) (<-chan []byte, func()) {
	ch := make(chan []byte, 64)
	h.mu.Lock()
	if h.subs[user] == nil {
		h.subs[user] = map[chan []byte]struct{}{}
	}
	h.subs[user][ch] = struct{}{}
	h.mu.Unlock()
	h.clients.Add(1)
	return ch, func() {
		h.mu.Lock()
		delete(h.subs[user], ch)
		if len(h.subs[user]) == 0 {
			delete(h.subs, user)
		}
		h.mu.Unlock()
		h.clients.Add(-1)
	}
}

// Publish never blocks: a slow client misses progress ticks rather than stalling others.
func (h *Hub) Publish(user string, payload []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.subs[user] {
		select {
		case ch <- payload:
		default:
			h.dropped.Add(1)
		}
	}
}

func (h *Hub) Clients() int64 { return h.clients.Load() }

// Route takes a Redis channel name and payload and publishes to the right user.
func (h *Hub) Route(channel string, payload []byte) {
	if user, ok := strings.CutPrefix(channel, "progress:user:"); ok && user != "" {
		h.Publish(user, payload)
	}
}

// ---- HTTP -------------------------------------------------------------------

type Server struct {
	Hub          *Hub
	Secret       []byte
	CookieName   string
	AllowOrigin  string
	Heartbeat    time.Duration
	Log          *slog.Logger
	ShuttingDown func() bool
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if s.ShuttingDown != nil && s.ShuttingDown() {
			http.Error(w, "shutting down", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /events", s.events)
	return mux
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if s.AllowOrigin != "" {
		w.Header().Set("Access-Control-Allow-Origin", s.AllowOrigin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Vary", "Origin")
	}
	ck, err := r.Cookie(s.CookieName)
	if err != nil {
		http.Error(w, "not signed in", http.StatusUnauthorized)
		return
	}
	claims, err := VerifyHS256(ck.Value, s.Secret, time.Now())
	if err != nil {
		http.Error(w, "not signed in", http.StatusUnauthorized)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering (ingress)

	ch, unsubscribe := s.Hub.Subscribe(claims.Sub)
	defer unsubscribe()
	// The session cookie can expire mid-stream; close then and let the browser reconnect.
	ctx, cancel := context.WithDeadline(r.Context(), time.Unix(claims.Exp, 0))
	defer cancel()

	fmt.Fprint(w, "retry: 3000\nevent: hello\ndata: {}\n\n")
	flusher.Flush()
	hb := time.NewTicker(s.Heartbeat)
	defer hb.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-hb.C:
			if s.ShuttingDown != nil && s.ShuttingDown() {
				return // client reconnects to another replica
			}
			fmt.Fprint(w, ": ping\n\n")
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
		}
		flusher.Flush()
	}
}
