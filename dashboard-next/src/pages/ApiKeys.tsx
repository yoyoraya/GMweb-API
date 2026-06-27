import { useEffect, useState } from "react";
import { Plus, RotateCw, Trash2, Copy, Power } from "lucide-react";
import { api } from "@/lib/api";
import type { ApiKey } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [ips, setIps] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);

  async function load() {
    const d = await api<{ keys: ApiKey[] }>("/admin/api-keys", { headers: { "Content-Type": "text/plain" } });
    setKeys(d.keys);
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const allowedIps = ips.trim() ? ips.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const d = await api<{ key: { token: string } }>("/admin/api-keys", { method: "POST", body: { name: name.trim(), allowedIps } });
    setFreshToken(d.key.token);
    setCreating(false);
    setName("");
    setIps("");
    load();
  }
  async function rotate(id: string) {
    const d = await api<{ key: { token: string } }>(`/admin/api-keys/${id}/rotate`, { method: "POST" });
    setFreshToken(d.key.token);
  }
  async function remove(id: string) {
    if (!confirm("Delete this key? Clients using it stop working immediately.")) return;
    await api(`/admin/api-keys/${id}`, { method: "DELETE" });
    load();
  }
  async function toggle(k: ApiKey) {
    await api(`/admin/api-keys/${k.id}`, { method: "PATCH", body: { enabled: !k.enabled } });
    load();
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <Button size="sm" onClick={() => setCreating((v) => !v)}>
            <Plus className="size-4" /> New key
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {creating && (
            <form onSubmit={create} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Project name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Project" required />
              </div>
              <div className="space-y-1">
                <Label>Allowed IPs (comma, blank = any)</Label>
                <Input value={ips} onChange={(e) => setIps(e.target.value)} placeholder="1.2.3.4, 5.6.7.8" />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" size="sm">Create</Button>
              </div>
            </form>
          )}

          {freshToken && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="mb-1 font-medium text-amber-300">Token — copy now, shown once</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-background/60 px-2 py-1 text-xs">{freshToken}</code>
                <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(freshToken)}>
                  <Copy className="size-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>Dismiss</Button>
              </div>
            </div>
          )}

          <div className="divide-y divide-border">
            {keys.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{k.name}</span>
                    <Badge variant={k.enabled ? "success" : "secondary"}>{k.enabled ? "enabled" : "disabled"}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {k.tokenPreview}… · {k.requestCount} reqs · {k.allowedIps.length ? k.allowedIps.join(", ") : "any IP"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => toggle(k)} title="Enable/disable">
                    <Power className="size-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => rotate(k.id)} title="Rotate token">
                    <RotateCw className="size-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(k.id)} title="Delete">
                    <Trash2 className="size-4 text-red-400" />
                  </Button>
                </div>
              </div>
            ))}
            {keys.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">No keys yet.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
