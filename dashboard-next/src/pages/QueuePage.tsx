import { useCallback, useEffect, useState } from "react";
import { ArrowUp, X, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { QueueCounts, QueueJob } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSSE } from "@/hooks/useSSE";
import { cn } from "@/lib/utils";

export function QueuePage() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, j] = await Promise.all([
        api<{ counts: QueueCounts }>("/admin/queue", { headers: { "Content-Type": "text/plain" } }),
        api<{ jobs: QueueJob[] }>("/admin/queue/jobs?limit=100", { headers: { "Content-Type": "text/plain" } }),
      ]);
      setCounts(c.counts);
      setJobs(j.jobs);
    } catch {
      /* transient */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  // live nudge on send events
  useSSE((e) => {
    if (e.type.startsWith("send_")) load();
  }, true);

  async function promote(id: string) {
    await api(`/admin/queue/jobs/${id}/promote`, { method: "POST" }).catch(() => {});
    load();
  }
  async function cancel(id: string) {
    if (!confirm("Cancel this queued message?")) return;
    await api(`/admin/queue/jobs/${id}`, { method: "DELETE" }).catch(() => {});
    load();
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
          <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {jobs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Queue is empty.</div>
        ) : (
          <div className="max-h-[60vh] divide-y divide-border overflow-y-auto">
            {jobs.map((job) => (
              <div key={job.id} className="flex items-center gap-3 px-4 py-3">
                <Badge variant={job.priority === "high" ? "warning" : job.state === "active" ? "default" : "secondary"}>
                  {job.priority === "high" ? "HIGH" : job.state}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{job.to ?? "—"}</div>
                  <div className="truncate text-xs text-muted-foreground" dir="auto">
                    {job.textPreview}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {job.keyName ?? "—"}
                    {job.attemptsMade ? ` · try ${job.attemptsMade}` : ""}
                    {job.createdAt ? ` · ${new Date(job.createdAt).toLocaleTimeString()}` : ""}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => promote(job.id)}
                    disabled={job.priority === "high" || job.state === "active"}
                    title="Process next"
                  >
                    <ArrowUp className="size-4" /> High
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => cancel(job.id)} disabled={job.state === "active"} title="Cancel">
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
