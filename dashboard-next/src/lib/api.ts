// Thin API client for the GMweb Fastify backend. Mirrors the vanilla dashboard:
// same-origin cookies (session + password session) + an X-CSRF-Token header on
// mutating calls. The CSRF token is handed out by /dashboard/login and
// /dashboard/session.

let csrfToken: string | null = sessionStorage.getItem("gmwebCsrfToken");

export function setCsrfToken(token: string | null) {
  csrfToken = token;
  if (token) sessionStorage.setItem("gmwebCsrfToken", token);
  else sessionStorage.removeItem("gmwebCsrfToken");
}

export function getCsrfToken() {
  return csrfToken;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Options = Omit<RequestInit, "body"> & { body?: unknown };

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };
  const res = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON (e.g. an nginx 5xx HTML page) — surface a clean error
    throw new ApiError(`HTTP ${res.status}`, res.status);
  }
  if (!res.ok) {
    const d = data as { message?: string; error?: string };
    throw new ApiError(d.message || d.error || `HTTP ${res.status}`, res.status);
  }
  return data as T;
}
