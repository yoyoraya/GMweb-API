import { useState } from "react";
import {
  Activity,
  Send,
  ListOrdered,
  MessagesSquare,
  KeyRound,
  SlidersHorizontal,
  Monitor,
  ScrollText,
  LogOut,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";

import { OverviewPage } from "@/pages/Overview";
import { SendPage } from "@/pages/SendPage";
import { QueuePage } from "@/pages/QueuePage";
import { ConversationsPage } from "@/pages/Conversations";
import { ApiKeysPage } from "@/pages/ApiKeys";
import { ControlsPage } from "@/pages/Controls";
import { VncPage } from "@/pages/Vnc";
import { LogsPage } from "@/pages/Logs";

const NAV = [
  { id: "overview", label: "Overview", icon: Activity, el: <OverviewPage /> },
  { id: "send", label: "Send", icon: Send, el: <SendPage /> },
  { id: "queue", label: "Queue", icon: ListOrdered, el: <QueuePage /> },
  { id: "conversations", label: "Conversations", icon: MessagesSquare, el: <ConversationsPage /> },
  { id: "apikeys", label: "API Keys", icon: KeyRound, el: <ApiKeysPage /> },
  { id: "controls", label: "Controls", icon: SlidersHorizontal, el: <ControlsPage /> },
  { id: "vnc", label: "VNC", icon: Monitor, el: <VncPage /> },
  { id: "logs", label: "Logs", icon: ScrollText, el: <LogsPage /> },
] as const;

export function Shell() {
  const { logout } = useSession();
  const [active, setActive] = useState<string>("overview");
  const current = NAV.find((n) => n.id === active) ?? NAV[0];

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 p-3 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2 pt-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <MessageSquare className="size-5" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">GMweb</div>
            <div className="text-[11px] text-muted-foreground">Messages Bridge</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === active;
            return (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <Button variant="ghost" className="justify-start text-muted-foreground" onClick={logout}>
          <LogOut className="size-4" /> Logout
        </Button>
      </aside>

      <main className="flex-1 overflow-x-hidden">
        {/* mobile top nav */}
        <div className="flex gap-1 overflow-x-auto border-b border-border p-2 md:hidden">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setActive(item.id)}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1.5 text-xs",
                item.id === active ? "bg-primary/15 text-primary" : "text-muted-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mx-auto max-w-6xl p-4 md:p-6">
          <h1 className="mb-4 text-xl font-semibold">{current.label}</h1>
          {current.el}
        </div>
      </main>
    </div>
  );
}
