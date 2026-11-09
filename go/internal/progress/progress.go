// Package progress publishes fine-grained, best-effort job progress to Redis pub/sub
// (channel "progress:<videoId>"); progress-svc (M3) fans it out to browsers via SSE.
package progress

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type Event struct {
	VideoID string  `json:"videoId"`
	Task    string  `json:"task"`
	Stage   string  `json:"stage"`
	Percent float64 `json:"percent"`
}

type Reporter interface {
	Report(ctx context.Context, e Event)
}

// Redis publishes at most every MinInterval per video/task (plus 0% and 100%).
type Redis struct {
	Client      *redis.Client
	Log         *slog.Logger
	MinInterval time.Duration
	mu          sync.Mutex
	last        map[string]time.Time
}

func (r *Redis) Report(ctx context.Context, e Event) {
	if r == nil || r.Client == nil {
		return
	}
	key := e.VideoID + "/" + e.Task
	r.mu.Lock()
	if r.last == nil {
		r.last = map[string]time.Time{}
	}
	if e.Percent > 0 && e.Percent < 100 && time.Since(r.last[key]) < r.MinInterval {
		r.mu.Unlock()
		return
	}
	r.last[key] = time.Now()
	r.mu.Unlock()

	b, _ := json.Marshal(e)
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if err := r.Client.Publish(ctx, "progress:"+e.VideoID, b).Err(); err != nil {
		r.Log.Debug("progress publish failed", "err", err) // best effort
	}
}

// Nop discards progress.
type Nop struct{}

func (Nop) Report(context.Context, Event) {}
