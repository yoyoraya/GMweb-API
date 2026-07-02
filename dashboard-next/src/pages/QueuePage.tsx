import { useCallback, useEffect, useState } from "react";
import { ArrowUp, X, RefreshCw, Pause, Play, Moon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { QueueCounts, QueueJob, QueueQuietHours } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSSE } from "@/hooks/useSSE";
import { cn } from "@/lib/utils";

function elapsed(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function QueuePage() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [paused, setPaused] = useState(false);
  const [quietHours, setQuietHours] = useState<QueueQuietHours | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [staleSince, setStaleSince] = useState<number | null>(null);

  function messageFor(err: unknown) {
    return err instanceof ApiError ? err.message : "network error";
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, j] = await Promise.all([
        api<{ counts: QueueCounts; paused: boolean; quietHours: QueueQuietHours }>("/admin/queue", { headers: { "Content-Type": "text/plain" } }),
        api<{ jobs: QueueJob[] }>("/admin/queue/jobs?limit=100", { headers: { "Content-Type": "text/plain" } }),
      ]);
      setCounts(c.counts);
      setPaused(c.paused);
      setQuietHours(c.quietHours);
      setJobs(j.jobs);
      setStaleSince(null);
    } catch (err) {
      // Background polling failure: don't yell at the user every 8s, but do
      // surface it if it persists — an expired session otherwise looks
      // exactly like "the queue is frozen" with no indication why.
      setStaleSince((prev) => prev ?? Date.now());
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [load]);

  // live nudge on send events
  useSSE((e) => {
    if (e.type.startsWith("send_") || e.type.startsWith("queue_")) load().catch(() => {});
  }, true);

  async function promote(id: string) {
    if (busyAction) return;
    setBusyAction(`promote:${id}`);
    setActionError("");
    try {
      await api(`/admin/queue/jobs/${id}/promote`, { method: "POST" });
      await load();
    } catch (err) {
      setActionError(`Couldn't promote: ${messageFor(err)}`);
    } finally {
      setBusyAction(null);
    }
  }
  async function cancel(id: string) {
    if (busyAction) return;
    if (!confirm("Cancel this queued message?")) return;
    setBusyAction(`cancel:${id}`);
    setActionError("");
    try {
      await api(`/admin/queue/jobs/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setActionError(`Couldn't cancel: ${messageFor(err)}`);
    } finally {
      setBusyAction(null);
    }
  }
  async function togglePaused() {
    if (busyAction) return;
    // Capture intent before the state can change under us — the alternative
    // (reading `paused` again after the request) is what let a stuck/slow
    // request cause a second click to resend the same action instead of the
    // opposite one.
    const target = paused ? "resume" : "pause";
    setBusyAction("toggle");
    setActionError("");
    try {
      await api(`/admin/queue/${target}`, { method: "POST" });
      await load();
    } catch (err) {
      setActionError(`Couldn't ${target}: ${messageFor(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send queue</CardTitle>
        <div className="flex items-center gap-2">
          {counts && (
            <span className="text-xs text-muted-foreground">
              {counts.waiting} waiting · {counts.active} active · {counts.failed} failed
            </span>
          )}
          <Badge variant={paused ? "warning" : "secondary"}>{paused ? "PAUSED" : "RUNNING"}</Badge>
          <Button variant="secondary" size="sm" onClick={togglePaused} disabled={busyAction !== null}>
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {busyAction === "toggle" ? "Working…" : paused ? "Resume paced" : "Pause"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => load().catch(() => {})} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
        {actionError && <div className="text-xs text-destructive">{actionError}</div>}
        {!actionError && staleSince && (
          <div className="text-xs text-destructive">
            Not updating since {new Date(staleSince).toLocaleTimeString()} — session may have expired, try reloading the page.
          </div>
        )}
        {quietHours?.active && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-amber-100">
            <Moon className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <div>
              <div className="text-sm font-medium">Quiet hours are active</div>
              <div className="text-xs text-amber-100/75">
                Normal SMS and every delayed retry—including HIGH—are held until {quietHours.releaseAt ? new Date(quietHours.releaseAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "08:00"} {quietHours.timeZone}. Only fresh HIGH messages send immediately.
              </div>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {jobs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Queue is empty.</div>
        ) : (
          <div className="max-h-[60vh] divide-y divide-border overflow-y-auto">
            {jobs.map((job) => (
              <div key={job.id} className="flex items-start gap-3 px-4 py-3">
                <div className="flex w-20 shrink-0 flex-col items-start gap-1">
                  <Badge variant={job.state === "active" ? "default" : job.state === "delayed" ? "warning" : "secondary"}>
                    {job.state}
                  </Badge>
                  {job.priority === "high" && <Badge variant="warning">HIGH</Badge>}
                  {job.quietHoursHeld && <Badge variant="warning">QUIET</Badge>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{job.to ?? "—"}</div>
                  <div className="truncate text-xs text-muted-foreground" dir="auto">
                    {job.textPreview}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {job.keyName ?? "—"}
                    {` · attempt ${job.attemptsMade + (job.state === "active" ? 1 : 0)}/${job.maxAttempts}`}
                    {job.createdAt ? ` · queued ${new Date(job.createdAt).toLocaleTimeString()}` : ""}
                    {job.processedAt ? ` · started ${new Date(job.processedAt).toLocaleTimeString()}` : ""}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    <span>in queue: {elapsed(job.waitingForMs)}</span>
                    {job.state === "active" && <span>active: {elapsed(job.activeForMs)}</span>}
                    {job.stageLabel && <span>stage: {job.stageLabel} ({elapsed(job.stageForMs)})</span>}
                    {job.quietHoursHeld && quietHours?.releaseAt ? (
                      <span>scheduled: {new Date(quietHours.releaseAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    ) : job.state === "delayed" && job.delayUntil && (
                      <span>{job.deferReason === "quiet_hours" ? "scheduled" : "retry"}: {new Date(job.delayUntil).toLocaleTimeString()}</span>
                    )}
                  </div>
                  <div
                    className={cn(
                      "mt-1 text-xs",
                      job.diagnosis.severity === "error" && "text-destructive",
                      job.diagnosis.severity === "warning" && "text-amber-400",
                      job.diagnosis.severity === "info" && "text-muted-foreground",
                    )}
                  >
                    {job.diagnosis.message}
                    {job.tracking === "redis_only" && " · legacy job (no SQLite timeline)"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => promote(job.id)}
                    disabled={job.priority === "high" || job.state === "active" || busyAction !== null}
                    title="Process next"
                  >
                    <ArrowUp className="size-4" /> High
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => cancel(job.id)}
                    disabled={job.state === "active" || busyAction !== null}
                    title="Cancel"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
