// Package progress publishes fine-grained, best-effort job progress to Redis pub/sub on
// the owner's channel ("progress:user:<ownerId>"); progress-svc fans it out via SSE.
// catalog-api publishes video status changes on the same channel.
package progress

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Channel is the Redis channel carrying a user's live events.
func Channel(ownerID string) string { return "progress:user:" + ownerID }

type Event struct {
	Kind    string  `json:"kind"` // always "progress"
	OwnerID string  `json:"-"`
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
	if r == nil || r.Client == nil || e.OwnerID == "" {
		return
	}
	e.Kind = "progress"
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
	if err := r.Client.Publish(ctx, Channel(e.OwnerID), b).Err(); err != nil {
		r.Log.Debug("progress publish failed", "err", err) // best effort
	}
}

// Nop discards progress.
type Nop struct{}

func (Nop) Report(context.Context, Event) {}
