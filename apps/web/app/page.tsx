"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type User, type Video } from "@/lib/api";
import { type PartProgress, uploadVideo } from "@/lib/upload";

interface ActiveUpload {
  key: string;
  name: string;
  parts: PartProgress[];
  error?: string;
  done?: boolean;
  controller: AbortController;
}

const fmtBytes = (n: number) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

const statusColor: Record<Video["status"], string> = {
  UPLOADING: "bg-amber-500/15 text-amber-300",
  UPLOADED: "bg-sky-500/15 text-sky-300",
  PROCESSING: "bg-violet-500/15 text-violet-300",
  READY: "bg-emerald-500/15 text-emerald-300",
  FAILED: "bg-red-500/15 text-red-300",
};

export default function HomePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [uploads, setUploads] = useState<ActiveUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => api<{ items: Video[] }>("/videos").then((r) => setVideos(r.items)), []);

  useEffect(() => {
    api<User>("/auth/me")
      .then((u) => (setUser(u), refresh()))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
      });
  }, [router, refresh]);

  const patch = (key: string, p: Partial<ActiveUpload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));

  async function start(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      const controller = new AbortController();
      setUploads((list) => [{ key, name: file.name, parts: [], controller }, ...list]);
      uploadVideo(
        file,
        { onStart: (_v, parts) => (patch(key, { parts }), refresh()), onProgress: (parts) => patch(key, { parts }) },
        controller.signal,
      )
        .then(() => patch(key, { done: true }))
        .catch((err) => patch(key, { error: (err as Error).message }))
        .finally(refresh);
    }
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  if (!user) return <main className="p-10 text-slate-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6 md:p-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">StreamForge</h1>
        <div className="flex items-center gap-4 text-sm text-slate-400">
          <span>{user.email}</span>
          <button onClick={logout} className="hover:text-slate-200">
            Sign out
          </button>
        </div>
      </header>

      <section
        onDragOver={(e) => (e.preventDefault(), setDragging(true))}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => (e.preventDefault(), setDragging(false), start(e.dataTransfer.files))}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-2xl border-2 border-dashed p-12 text-center transition ${
          dragging ? "border-indigo-400 bg-indigo-500/10" : "border-slate-700 hover:border-slate-500"
        }`}
      >
        <p className="text-lg font-medium">Drop videos here or click to choose</p>
        <p className="mt-1 text-sm text-slate-400">Up to 200 MB and 5 minutes each. Uploads go straight to storage in parallel chunks.</p>
        <input
          ref={input}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => e.target.files && start(e.target.files)}
        />
      </section>

      {uploads.length > 0 && (
        <section className="space-y-3">
          {uploads.map((u) => {
            const total = u.parts.reduce((s, p) => s + p.total, 0);
            const loaded = u.parts.reduce((s, p) => s + p.loaded, 0);
            const pct = total ? Math.round((loaded / total) * 100) : 0;
            return (
              <div key={u.key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate font-medium">{u.name}</span>
                  <span className={u.error ? "text-red-400" : u.done ? "text-emerald-400" : "text-slate-400"}>
                    {u.error ?? (u.done ? "Uploaded" : `${pct}% · ${fmtBytes(loaded)} / ${fmtBytes(total)}`)}
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-2 flex gap-1" title="Per-chunk progress">
                  {u.parts.map((p) => (
                    <div key={p.partNumber} className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
                      <div
                        className={`h-full ${p.state === "retrying" ? "bg-amber-400" : p.state === "done" ? "bg-emerald-500" : "bg-indigo-400"}`}
                        style={{ width: `${(p.loaded / p.total) * 100}%` }}
                      />
                    </div>
                  ))}
                </div>
                {!u.done && !u.error && (
                  <button onClick={() => u.controller.abort()} className="mt-2 text-xs text-slate-500 hover:text-red-300">
                    Cancel
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-medium">Library</h2>
        {videos.length === 0 ? (
          <p className="rounded-xl border border-slate-800 p-8 text-center text-slate-500">No videos yet. Drop one above.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-left text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-normal">Title</th>
                  <th className="px-4 py-2 font-normal">Size</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="hidden px-4 py-2 font-normal md:table-cell">Added</th>
                </tr>
              </thead>
              <tbody>
                {videos.map((v) => (
                  <tr key={v.id} className="border-t border-slate-800">
                    <td className="px-4 py-2">{v.title}</td>
                    <td className="px-4 py-2 text-slate-400">{fmtBytes(v.sizeBytes)}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[v.status]}`} title={v.failureReason ?? ""}>
                        {v.status}
                      </span>
                    </td>
                    <td className="hidden px-4 py-2 text-slate-400 md:table-cell">{new Date(v.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
