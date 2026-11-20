"use client";

import { useEffect, useRef } from "react";
import { History, Plus } from "lucide-react";
import { TenantPicker } from "@/components/admin/TenantPicker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Composer } from "./Composer";
import { SuggestionCard } from "./SuggestionCard";
import { formatDay, formatTime, type GrowthSuggestion, type SuggestionSession } from "./types";

export type ChatMessage = {
  id: string;
  role: "staff" | "zavi";
  text: string;
  at: string;
  suggestions?: GrowthSuggestion[];
};

export type SuggestionActions = {
  busyIds: Set<string>;
  onEdit: (suggestion: GrowthSuggestion) => void;
  onArchive: (suggestion: GrowthSuggestion) => void;
  onPush: (suggestion: GrowthSuggestion) => void;
  onPushAll: (suggestions: GrowthSuggestion[]) => void;
};

export type ChatHistory = {
  sessions: SuggestionSession[];
  loading: boolean;
  activeId: string | null;
  onOpen: () => void;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
};

export function ChatPanel({
  tenantId,
  onTenantChange,
  messages,
  sending,
  loadingSession,
  error,
  onSend,
  onAddManual,
  actions,
  history,
  prefill,
}: {
  tenantId: string;
  onTenantChange: (tenantId: string) => void;
  messages: ChatMessage[];
  sending: boolean;
  loadingSession: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onAddManual: () => void;
  actions: SuggestionActions;
  history: ChatHistory;
  prefill?: { id: number; text: string } | null;
}) {
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (messagesElement) messagesElement.scrollTop = messagesElement.scrollHeight;
  }, [messages, sending]);

  return (
    <section className="flex h-full min-h-0 w-[520px] min-w-[440px] shrink-0 flex-col overflow-hidden border-r bg-card">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <TenantPicker
          value={tenantId}
          onChange={onTenantChange}
          placeholder="Choose a client…"
          variant="pill"
          disabled={sending}
        />
        <DropdownMenu onOpenChange={(open) => open && history.onOpen()}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto shrink-0" disabled={!tenantId}>
              <History className="size-4" />
              History
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
            <DropdownMenuItem onSelect={history.onNew}>
              <Plus className="size-4" />
              New session
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {history.loading ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">Loading sessions…</p>
            ) : history.sessions.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">No past sessions for this client yet.</p>
            ) : (
              history.sessions.map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  onSelect={() => history.onSelect(session.id)}
                  className={`flex-col items-start gap-1 ${session.id === history.activeId ? "bg-accent" : ""}`}
                >
                  <span className="line-clamp-2 text-xs font-medium">{session.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDay(session.last_message_at)} · {formatTime(session.last_message_at)}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div ref={messagesRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {messages.length === 0 && (
          <p className="pt-16 text-center text-sm text-muted-foreground">
            {loadingSession
              ? "Loading session…"
              : tenantId
                ? "Ask Zavi to scan this client's ads and draft growth suggestions."
                : "Pick a client to start."}
          </p>
        )}

        {messages.map((message) =>
          message.role === "staff" ? (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-2xl rounded-xl rounded-br-sm bg-muted px-4 py-3">
                <p className="whitespace-pre-wrap text-sm leading-5">{message.text}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  You · {formatTime(message.at)}
                </p>
              </div>
            </div>
          ) : (
            <div key={message.id} className="max-w-2xl space-y-3">
              <div>
                <p className="text-xs font-bold">Zavi</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-5">{message.text}</p>
              </div>
              {message.suggestions && message.suggestions.length > 0 && (
                <SuggestionCard suggestions={message.suggestions} {...actions} />
              )}
            </div>
          ),
        )}

        {sending && (
          <p className="text-sm text-muted-foreground">Zavi is scanning the client&apos;s ads…</p>
        )}

      </div>

      <Composer
        disabled={!tenantId}
        sending={sending}
        onSend={onSend}
        onAddManual={onAddManual}
        prefill={prefill}
      />
    </section>
  );
}
