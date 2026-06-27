import { useState } from "react";
import { motion } from "framer-motion";
import { KeyRound, Loader2, Lock, MessageSquare } from "lucide-react";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Login() {
  const { passwordRequired, passwordAuthenticated, passwordLogin, tokenLogin } = useSession();
  const needPassword = passwordRequired && !passwordAuthenticated;
  const [username, setUsername] = useState("gmwebadmin");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (needPassword) await passwordLogin(username.trim(), password);
      else await tokenLogin(token.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background bg-grid p-4">
      <div className="absolute inset-0 bg-gradient-to-b from-background/0 via-background/40 to-background" />
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative w-full max-w-sm rounded-2xl border border-border bg-card/80 p-7 shadow-2xl backdrop-blur"
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <MessageSquare className="size-6" />
          </div>
          <h1 className="text-lg font-semibold">GMweb Console</h1>
          <p className="text-xs text-muted-foreground">Google Messages → REST bridge</p>
        </div>

        <div className="mb-5 flex items-center justify-center gap-2 text-xs">
          <span className={needPassword ? "text-primary font-medium" : "text-muted-foreground"}>1 · Password</span>
          <span className="text-muted-foreground">→</span>
          <span className={!needPassword ? "text-primary font-medium" : "text-muted-foreground"}>2 · API token</span>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {needPassword ? (
            <>
              <div className="space-y-1">
                <Label>Username</Label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
              </div>
              <div className="space-y-1">
                <Label>Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Dashboard password"
                />
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <Label>API token</Label>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste master API token"
                autoFocus
              />
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : needPassword ? (
              <Lock className="size-4" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {needPassword ? "Continue" : "Unlock dashboard"}
          </Button>
        </form>
      </motion.div>
    </div>
  );
}
