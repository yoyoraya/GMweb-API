import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Send as SendIcon, MessageSquare, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { Conversation, Message } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ── helpers ──────────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  "bg-rose-500/80", "bg-orange-500/80", "bg-amber-500/80", "bg-emerald-500/80",
  "bg-teal-500/80", "bg-sky-500/80", "bg-indigo-500/80", "bg-fuchsia-500/80",
];
function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(title: string) {
  const t = (title || "?").trim();
  if (/^[+\d\s()-]+$/.test(t)) return t.replace(/\D/g, "").slice(-2) || "#";
  const parts = t.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || t[0].toUpperCase();
}
// A conversation is "dialable" (composer enabled) when its title is a phone number.
function dialNumber(title: string) {
  if (/^[+\d\s()-]+$/.test(title || "")) return (title || "").replace(/[^\d+]/g, "");
  return null;
}

function Avatar({ title, size = "h-10 w-10" }: { title: string; size?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white", size, avatarColor(title))}>
      {initials(title)}
    </div>
  );
}

export function ConversationsPage() {
  const [list, setList] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);

  async function loadList() {
    setLoading(true);
    try {
      const d = await api<{ conversations: Conversation[] }>("/conversations?limit=200", {
        headers: { "Content-Type": "text/plain" },
      });
      setList(d.conversations);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadList();
  }, []);

  async function loadThread(c: Conversation, silent = false) {
    if (!silent) setLoadingMsg(true);
    try {
      const d = await api<{ messages: Message[] }>("/conversations/messages", {
        method: "POST",
        body: { href: c.href, limit: 80 },
      });
      setMessages(d.messages);
    } finally {
      setLoadingMsg(false);
    }
  }

  function openConv(c: Conversation) {
    setOpen(c);
    setMessages([]);
    setDraft("");
    loadThread(c);
  }

  // live-refresh the open thread every 6s (like GM web syncing)
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => loadThread(open, true), 6000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const number = open ? dialNumber(open.title) : null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!number || !draft.trim()) return;
    setSending(true);
    try {
      await api("/send", { method: "POST", body: { to: number, text: draft.trim() } });
      setDraft("");
      // optimistic — refetch shortly after the worker sends
      setTimeout(() => open && loadThread(open, true), 2500);
    } finally {
      setSending(false);
    }
  }

  const shown = list.filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex h-[calc(100vh-9rem)] overflow-hidden rounded-xl border border-border bg-card">
      {/* ── left rail: conversation list ── */}
      <div className={cn("flex w-full flex-col border-r border-border md:w-[340px]", open && "hidden md:flex")}>
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search conversations"
              className="h-9 w-full rounded-full border border-input bg-background/60 pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <Button variant="ghost" size="icon" onClick={loadList} disabled={loading} title="Reload">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {shown.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {loading ? "Loading…" : "No conversations."}
            </div>
          ) : (
            shown.map((c) => (
              <button
                key={c.id || c.href}
                onClick={() => openConv(c)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  open?.href === c.href ? "bg-primary/10" : "hover:bg-accent"
                )}
              >
                <Avatar title={c.title} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("truncate text-sm", c.unread ? "font-semibold" : "font-medium")}>{c.title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{c.timestamp}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("truncate text-xs", c.unread ? "text-foreground" : "text-muted-foreground")} dir="auto">
                      {c.snippet}
                    </span>
                    {c.unread && <span className="ml-auto size-2 shrink-0 rounded-full bg-primary" />}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── right pane: thread ── */}
      <div className={cn("flex flex-1 flex-col", !open && "hidden md:flex")}>
        {!open ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <div className="flex size-16 items-center justify-center rounded-full bg-secondary">
              <MessageSquare className="size-7" />
            </div>
            <p className="text-sm">Select a conversation</p>
          </div>
        ) : (
          <>
            {/* thread header */}
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <button className="text-muted-foreground md:hidden" onClick={() => setOpen(null)}>←</button>
              <Avatar title={open.title} size="h-9 w-9" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{open.title}</div>
                <div className="text-[11px] text-muted-foreground">{number ? "SMS" : "contact"}</div>
              </div>
              {loadingMsg && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" />}
            </div>

            {/* messages */}
            <div className="flex-1 space-y-1.5 overflow-y-auto bg-background/40 px-4 py-4">
              {messages.map((m) =>
                m.type === "timestamp" ? (
                  <div key={m.index} className="py-2 text-center text-[11px] text-muted-foreground">{m.text}</div>
                ) : (
                  <div key={m.index} className={cn("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
                    <div
                      dir="auto"
                      className={cn(
                        "max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm",
                        m.direction === "out"
                          ? "rounded-br-md bg-primary text-primary-foreground"
                          : "rounded-bl-md bg-secondary text-secondary-foreground"
                      )}
                    >
                      {m.text}
                    </div>
                  </div>
                )
              )}
              {!loadingMsg && messages.length === 0 && (
                <div className="py-10 text-center text-sm text-muted-foreground">No messages.</div>
              )}
              <div ref={threadEnd} />
            </div>

            {/* composer */}
            <form onSubmit={send} className="flex items-center gap-2 border-t border-border p-3">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={number ? "Text message" : "Can only reply to numeric conversations"}
                disabled={!number || sending}
                dir="auto"
                className="h-10 flex-1 rounded-full border border-input bg-background/60 px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              />
              <Button type="submit" size="icon" className="rounded-full" disabled={!number || !draft.trim() || sending}>
                {sending ? <Loader2 className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
