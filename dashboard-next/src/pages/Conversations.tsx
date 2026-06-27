import { useState } from "react";
import { Loader2, Download, ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import type { Conversation, Message } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function ConversationsPage() {
  const [list, setList] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsg, setLoadingMsg] = useState(false);

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

  async function openConv(c: Conversation) {
    setOpen(c);
    setLoadingMsg(true);
    setMessages([]);
    try {
      const d = await api<{ messages: Message[] }>("/conversations/messages", {
        method: "POST",
        body: { href: c.href, limit: 60 },
      });
      setMessages(d.messages);
    } finally {
      setLoadingMsg(false);
    }
  }

  if (open) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setOpen(null)}>
              <ArrowLeft className="size-4" />
            </Button>
            <CardTitle>{open.title}</CardTitle>
          </div>
          {loadingMsg && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        </CardHeader>
        <CardContent className="space-y-2">
          {messages.map((m) =>
            m.type === "timestamp" ? (
              <div key={m.index} className="py-1 text-center text-[11px] text-muted-foreground">
                {m.text}
              </div>
            ) : (
              <div
                key={m.index}
                dir="auto"
                className={cn(
                  "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                  m.direction === "out"
                    ? "ml-auto bg-primary/15 text-foreground"
                    : "mr-auto bg-secondary text-secondary-foreground"
                )}
              >
                {m.text}
              </div>
            )
          )}
          {!loadingMsg && messages.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">No messages.</div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversations</CardTitle>
        <Button variant="secondary" size="sm" onClick={loadList} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Load
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {list.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Press Load to fetch conversations.</div>
        ) : (
          <div className="max-h-[65vh] divide-y divide-border overflow-y-auto">
            {list.map((c) => (
              <button
                key={c.id || c.href}
                onClick={() => openConv(c)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{c.title}</span>
                    {c.unread && <Badge variant="default">{c.unreadCount || "•"}</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground" dir="auto">
                    {c.snippet}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">{c.timestamp}</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
