// Pushes video status changes to the owner's live channel (progress-svc -> SSE).
import { createClient } from "redis";

export interface Notifier {
  videoChanged(ownerId: string, videoId: string, status: string): Promise<void>;
  close(): Promise<void>;
}

export const channelFor = (ownerId: string) => `progress:user:${ownerId}`;

export async function createNotifier(url: string | undefined, log: { warn(o: object, m: string): void }): Promise<Notifier> {
  if (!url) return { videoChanged: async () => {}, close: async () => {} };
  const client = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: (n) => Math.min(n * 200, 5000) } });
  client.on("error", (err) => log.warn({ err }, "redis error"));
  await client.connect().catch((err) => log.warn({ err }, "redis unavailable; live updates disabled until it reconnects"));
  return {
    async videoChanged(ownerId, videoId, status) {
      if (!client.isReady) return; // best effort: the UI also refreshes on its own
      await client.publish(channelFor(ownerId), JSON.stringify({ kind: "video", videoId, status })).catch(() => {});
    },
    async close() {
      if (client.isOpen) await client.quit();
    },
  };
}
