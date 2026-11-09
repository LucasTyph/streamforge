"use client";

import { RefreshCw, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

interface Depth {
  visible: number;
  inFlight: number;
  delayed: number;
}
interface QueueRow {
  name: string;
  main: Depth;
  dlq: Depth;
}
interface DlqMessage {
  messageId: string;
  videoId: string | null;
  type: string | null;
  receiveCount: number;
  sentAt: string | null;
  body: string;
}
interface FailedJob {
  videoId: string;
  title: string;
  task: string;
  attempts: number;
  error: string | null;
  updatedAt: string;
}

export default function AdminPage() {
  const { user } = useSession();
  const [queues, setQueues] = useState<QueueRow[] | null>(null);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<DlqMessage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [q, f] = await Promise.all([
        api<{ queues: QueueRow[] }>("/admin/queues"),
        api<{ items: FailedJob[] }>("/admin/jobs/failed"),
      ]);
      setQueues(q.queues);
      setFailed(f.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const inspect = useCallback(async (name: string) => {
    setSelected(name);
    setMessages(null);
    const r = await api<{ messages: DlqMessage[] }>(`/admin/dlq/${name}`).catch(() => ({ messages: [] }));
    setMessages(r.messages);
  }, []);

  useEffect(() => {
    if (!user?.isAdmin) return;
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [user, load]);

  async function redrive(name: string) {
    setBusy(name);
    try {
      const { moved } = await api<{ moved: number }>(`/admin/dlq/${name}/redrive`, { method: "POST" });
      toast.success(`Moved ${moved} message${moved === 1 ? "" : "s"} back to ${name}`);
      await load();
      if (selected === name) await inspect(name);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 md:px-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Ops</h1>
            <p className="text-sm text-muted-foreground">Queue depths refresh every 3 seconds. Dead-lettered jobs can be inspected and redriven.</p>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        </div>

        {user && !user.isAdmin && <p className="text-muted-foreground">This page is for admins.</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}

        {user?.isAdmin && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Queues</CardTitle>
                <CardDescription>Messages waiting, being processed, and dead-lettered after 3 failed attempts.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table data-testid="queues-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Queue</TableHead>
                      <TableHead className="text-right">Waiting</TableHead>
                      <TableHead className="text-right">In flight</TableHead>
                      <TableHead className="text-right">DLQ</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(queues ?? []).map((q) => (
                      <TableRow key={q.name} data-queue={q.name}>
                        <TableCell className="font-medium">{q.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{q.main.visible + q.main.delayed}</TableCell>
                        <TableCell className="text-right tabular-nums">{q.main.inFlight}</TableCell>
                        <TableCell className={cn("text-right font-medium tabular-nums", q.dlq.visible + q.dlq.inFlight > 0 && "text-red-500")}>
                          {q.dlq.visible + q.dlq.inFlight}
                        </TableCell>
                        <TableCell className="space-x-2 text-right whitespace-nowrap">
                          <Button variant="ghost" size="sm" onClick={() => inspect(q.name)}>
                            Inspect DLQ
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === q.name || q.dlq.visible === 0}
                            onClick={() => redrive(q.name)}
                          >
                            <RotateCcw className="size-4" /> Redrive
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {selected && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{selected}-dlq</CardTitle>
                  <CardDescription>Up to 10 messages (peeking leaves them in the queue).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {messages === null ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                  ) : messages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Empty. Nothing has failed permanently here.</p>
                  ) : (
                    messages.map((m) => (
                      <details key={m.messageId} className="rounded-lg border p-3 text-sm">
                        <summary className="cursor-pointer">
                          {m.type ?? "message"} ·{" "}
                          {m.videoId ? (
                            <Link className="underline" href={`/videos/${m.videoId}`}>
                              {m.videoId.slice(0, 8)}
                            </Link>
                          ) : (
                            "no videoId"
                          )}{" "}
                          · {m.receiveCount} receives {m.sentAt && `· sent ${new Date(m.sentAt).toLocaleString()}`}
                        </summary>
                        <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{m.body}</pre>
                      </details>
                    ))
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent failed jobs</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {failed.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No failed jobs.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Video</TableHead>
                        <TableHead>Task</TableHead>
                        <TableHead className="text-right">Attempts</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>When</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {failed.map((j) => (
                        <TableRow key={`${j.videoId}-${j.task}`}>
                          <TableCell>
                            <Link className="hover:underline" href={`/videos/${j.videoId}`}>
                              {j.title}
                            </Link>
                          </TableCell>
                          <TableCell>{j.task}</TableCell>
                          <TableCell className="text-right tabular-nums">{j.attempts}</TableCell>
                          <TableCell className="max-w-72 truncate text-red-500" title={j.error ?? ""}>
                            {j.error}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{new Date(j.updatedAt).toLocaleString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </>
  );
}
