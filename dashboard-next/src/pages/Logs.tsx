import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LogRow {
  ts: string;
  keyName?: string;
  method: string;
  path: string;
  ip: string;
}

export function LogsPage() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const d = await api<{ logs: LogRow[] }>("/admin/api-logs?limit=150", { headers: { "Content-Type": "text/plain" } });
      setLogs(d.logs || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>API request log</CardTitle>
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {logs.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No requests logged yet.</div>
        ) : (
          <div className="max-h-[65vh] overflow-y-auto font-mono text-xs">
            {logs.map((l, i) => (
              <div key={i} className="grid grid-cols-[130px_110px_50px_1fr_auto] gap-2 border-b border-border px-4 py-1.5">
                <span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString()}</span>
                <span className="truncate text-muted-foreground">{l.keyName || "—"}</span>
                <span className="text-primary">{l.method}</span>
                <span className="truncate">{l.path}</span>
                <span className="text-muted-foreground">{l.ip}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
