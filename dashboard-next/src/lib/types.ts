export interface SessionInfo {
  passwordRequired: boolean;
  passwordAuthenticated: boolean;
  authenticated: boolean;
  csrfToken: string | null;
  expiresAt: string | null;
}

export interface ReadyStatus {
  ready?: boolean;
  status?: {
    paired?: boolean;
    running?: boolean;
    url?: string;
    title?: string;
    hint?: string;
    qrVisible?: boolean;
    signInVisible?: boolean;
  };
}

export interface Overview {
  ok: boolean;
  version: string;
  readiness?: { ready: boolean; status?: Record<string, unknown> };
  vnc?: { ready?: boolean };
  services?: Array<{ name: string; active: string; enabled: string }>;
}

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface QueueJob {
  id: string;
  state: string;
  to: string | null;
  textPreview: string;
  keyName: string | null;
  priority: "high" | "normal";
  attemptsMade: number;
  createdAt: string | null;
}

export interface Conversation {
  id: string;
  href: string;
  title: string;
  snippet: string;
  timestamp: string;
  unread?: boolean;
  unreadCount?: number;
}

export interface Message {
  index: number;
  type: "message" | "timestamp";
  direction?: "in" | "out";
  text: string;
}

export interface ApiKey {
  id: string;
  name: string;
  allowedIps: string[];
  sendRateMinute: number;
  sendRateHour: number;
  createdAt: string;
  lastUsedAt: string | null;
  requestCount: number;
  enabled: boolean;
  tokenPreview: string;
}
