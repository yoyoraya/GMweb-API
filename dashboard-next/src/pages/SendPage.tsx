import { useState } from "react";
import { Send, Loader2, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function SendPage() {
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [high, setHigh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ jobId: string; status: string; priority?: string }>("/send", {
        method: "POST",
        body: { to: to.trim(), text, ...(high ? { priority: "high" } : {}) },
      });
      setResult({ ok: true, msg: `Queued · job ${r.jobId} · ${r.priority ?? "normal"}` });
      setText("");
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : "Send failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Send a message</CardTitle>
        {result && <Badge variant={result.ok ? "success" : "destructive"}>{result.ok ? "queued" : "error"}</Badge>}
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1">
            <Label>To</Label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+989121234567" />
          </div>
          <div className="space-y-1">
            <Label>Text</Label>
            <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Message text" />
          </div>
          <button
            type="button"
            onClick={() => setHigh((v) => !v)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors",
              high ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-border text-muted-foreground hover:bg-accent"
            )}
          >
            <span className="flex items-center gap-2">
              <Zap className="size-4" /> High priority (jump the queue)
            </span>
            <span className={cn("h-5 w-9 rounded-full p-0.5 transition-colors", high ? "bg-amber-500" : "bg-secondary")}>
              <span className={cn("block size-4 rounded-full bg-white transition-transform", high && "translate-x-4")} />
            </span>
          </button>

          {result && <p className={cn("text-xs", result.ok ? "text-emerald-400" : "text-red-400")}>{result.msg}</p>}

          <Button type="submit" className="w-full" disabled={busy || !to || !text}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
