import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setCsrfToken } from "./api";
import type { SessionInfo } from "./types";

interface SessionState {
  ready: boolean;            // initial restore finished
  authenticated: boolean;
  passwordRequired: boolean;
  passwordAuthenticated: boolean;
  refresh: () => Promise<SessionInfo>;
  passwordLogin: (username: string, password: string) => Promise<void>;
  tokenLogin: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [passwordAuthenticated, setPasswordAuthenticated] = useState(false);

  async function refresh() {
    const s = await api<SessionInfo>("/dashboard/session");
    setPasswordRequired(s.passwordRequired);
    setPasswordAuthenticated(s.passwordAuthenticated);
    setAuthenticated(s.authenticated);
    if (s.authenticated && s.csrfToken) setCsrfToken(s.csrfToken);
    return s;
  }

  useEffect(() => {
    refresh()
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  async function passwordLogin(username: string, password: string) {
    await api("/dashboard/password-login", { method: "POST", body: { username, password } });
    await refresh();
  }

  async function tokenLogin(token: string) {
    const r = await api<{ ok: boolean; csrfToken: string }>("/dashboard/login", {
      method: "POST",
      body: { token },
    });
    if (r.csrfToken) setCsrfToken(r.csrfToken);
    setAuthenticated(true);
  }

  async function logout() {
    await api("/dashboard/logout", { method: "POST" }).catch(() => {});
    setCsrfToken(null);
    setAuthenticated(false);
    setPasswordAuthenticated(false);
  }

  return (
    <Ctx.Provider
      value={{ ready, authenticated, passwordRequired, passwordAuthenticated, refresh, passwordLogin, tokenLogin, logout }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
