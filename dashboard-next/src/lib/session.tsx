import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setCsrfToken, setUnauthorizedHandler } from "./api";
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
    // Any page's background poll can be the one that discovers the session
    // is stale (TTL expiry, server restart, or a mismatched CSRF token from
    // a duplicate login). Re-check against the server's truth: if there's
    // still a valid session this silently resyncs the csrf token, otherwise
    // it drops `authenticated` so Gate falls back to the login screen —
    // either way the page stops being invisibly stuck.
    setUnauthorizedHandler(() => {
      refresh().catch(() => {
        setAuthenticated(false);
        setCsrfToken(null);
      });
    });
    refresh()
      .catch(() => {})
      .finally(() => setReady(true));
    return () => setUnauthorizedHandler(null);
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
