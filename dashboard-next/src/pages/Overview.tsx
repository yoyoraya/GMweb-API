import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { Overview, QueueCounts } from "@/lib/types";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function StatePill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm font-medium", ok ? "text-emerald-400" : "text-red-400")}>
      {ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
      {label}
    </span>
  );
}

function bytes(value = 0) {
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(0)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function ResourceBar({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
      <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function OverviewPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [queuePaused, setQueuePaused] = useState(false);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [o, c] = await Promise.all([
        api<Overview>("/admin/overview", { headers: { "Content-Type": "text/plain" } }),
        api<{ counts: QueueCounts; paused: boolean }>("/admin/queue", { headers: { "Content-Type": "text/plain" } }),
      ]);
      setOv(o);
      setCounts(c.counts);
      setQueuePaused(c.paused);
    } catch {
      /* shown via state */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const paired = Boolean(ov?.readiness?.ready);
  const svc = (name: string) => ov?.services?.find((s) => s.name === name)?.active === "active";
  const apiOk = ov?.ok ?? false;
  const chromeOk = svc("gmweb-chrome.service");
  const automationOk = chromeOk && ov?.browserAutomation?.ok !== false;
  const vncOk = ov?.vnc?.ready ?? false;
  const system = ov?.system;

  const metrics = [
    { k: "Pairing", node: <StatePill ok={paired} label={paired ? "Paired" : "Not paired"} />, sub: String(ov?.readiness?.status && (ov.readiness.status as { hint?: string }).hint) || "—" },
    { k: "API", node: <StatePill ok={apiOk} label={apiOk ? "Healthy" : "Down"} />, sub: `v${ov?.version ?? "—"} · :3030` },
    {
      k: "Chrome automation",
      node: <StatePill ok={automationOk} label={!chromeOk ? "Stopped" : ov?.browserAutomation?.ok === false ? "Hung" : "Healthy"} />,
      sub: `${ov?.browserAutomation?.code ?? "not checked"}${ov?.browserAutomation?.latencyMs ? ` · ${ov.browserAutomation.latencyMs}ms` : ""}`
    },
    { k: "VNC", node: <StatePill ok={vncOk} label={vncOk ? "On" : "Off"} />, sub: "pairing console" },
  ];

  const queueCards: Array<{ k: string; v: number; tone: string }> = [
    { k: "Waiting", v: counts?.waiting ?? 0, tone: "text-amber-400" },
    { k: "Active", v: counts?.active ?? 0, tone: "text-primary" },
    { k: "Completed", v: counts?.completed ?? 0, tone: "text-emerald-400" },
    { k: "Failed", v: counts?.failed ?? 0, tone: "text-red-400" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {metrics.map((m) => (
          <SpotlightCard key={m.k} className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{m.k}</div>
            <div className="mt-2">{m.node}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{m.sub}</div>
          </SpotlightCard>
        ))}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">System resources</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <SpotlightCard className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">CPU</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{system?.cpu.usagePercent?.toFixed(1) ?? "—"}%</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {system ? `${system.cpu.cores} cores · load ${system.cpu.load1.toFixed(2)} (${system.cpu.loadPercent.toFixed(0)}%)` : "—"}
            </div>
            <ResourceBar value={system?.cpu.usagePercent ?? 0} tone={(system?.cpu.usagePercent ?? 0) > 90 ? "bg-red-500" : "bg-primary"} />
          </SpotlightCard>
          <SpotlightCard className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Memory</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{system?.memory.usagePercent?.toFixed(1) ?? "—"}%</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {system ? `${bytes(system.memory.usedBytes)} / ${bytes(system.memory.totalBytes)} · ${bytes(system.memory.availableBytes)} available` : "—"}
            </div>
            <ResourceBar value={system?.memory.usagePercent ?? 0} tone={(system?.memory.usagePercent ?? 0) > 90 ? "bg-red-500" : "bg-emerald-500"} />
          </SpotlightCard>
          <SpotlightCard className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Swap</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{system?.swap.usagePercent?.toFixed(1) ?? "—"}%</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {system ? `${bytes(system.swap.usedBytes)} / ${bytes(system.swap.totalBytes)}` : "—"}
            </div>
            <ResourceBar value={system?.swap.usagePercent ?? 0} tone="bg-amber-500" />
          </SpotlightCard>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Send queue</h2>
          {queuePaused
            ? <Badge variant="warning">paused</Badge>
            : counts && counts.waiting + counts.active === 0 && <Badge variant="success">idle</Badge>}
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {queueCards.map((c) => (
            <SpotlightCard key={c.k} className="p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.k}</div>
              <div className={cn("mt-2 text-3xl font-semibold tabular-nums", c.tone)}>
                <AnimatedNumber value={c.v} />
              </div>
            </SpotlightCard>
          ))}
        </div>
      </div>
    </div>
  );
}
