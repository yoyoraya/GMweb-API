import { useState } from "react";
import { Play, RotateCcw, Globe, MonitorUp, MonitorX, Activity } from "lucide-react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const ACTIONS = [
  { id: "browser-start", label: "Start Browser", icon: Play },
  { id: "browser-restart", label: "Restart Browser", icon: RotateCcw },
  { id: "restart-chrome", label: "Restart Chrome", icon: Globe },
  { id: "vnc-on", label: "VNC On", icon: MonitorUp },
  { id: "vnc-off", label: "VNC Off", icon: MonitorX },
  { id: "smoke", label: "Smoke Test", icon: Activity },
] as const;

export function ControlsPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  async function run(action: string) {
    setBusy(action);
    setMsg("");
    try {
      const r = await api<{ ok: boolean; queued?: boolean }>("/admin/action", { method: "POST", body: { action } });
      setMsg(`${action}: ${r.queued ? "queued" : r.ok ? "done" : "failed"}`);
    } catch (err) {
      setMsg(`${action}: ${err instanceof Error ? err.message : "error"}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Controls</CardTitle>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3">
        {ACTIONS.map((a) => {
          const Icon = a.icon;
          return (
            <Button key={a.id} variant="secondary" disabled={busy !== null} onClick={() => run(a.id)} className="justify-start">
              <Icon className="size-4" /> {a.label}
            </Button>
          );
        })}
      </CardContent>
    </Card>
  );
}
