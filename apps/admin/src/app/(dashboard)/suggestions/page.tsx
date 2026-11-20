"use client";

import { Suspense, useCallback, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChatPanel, type ChatMessage } from "@/components/admin/suggestions/ChatPanel";
import {
  SuggestionEditorModal,
  type SuggestionEditorValue,
} from "@/components/admin/suggestions/SuggestionEditorModal";
import type { GrowthSuggestion, SuggestionSession } from "@/components/admin/suggestions/types";
import { Workspace } from "@/components/admin/suggestions/workspace/Workspace";
import { adminApiFetch } from "@/lib/api-admin";

type Editor = { mode: "create" } | { mode: "edit"; suggestion: GrowthSuggestion };

type StoredMessage = {
  id: string;
  role: ChatMessage["role"];
  body: string;
  created_at: string;
  suggestions?: GrowthSuggestion[];
};

async function request(path: string, init: RequestInit = {}) {
  const res = await adminApiFetch(path, init);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error?.message ?? `HTTP ${res.status}`);
  return payload;
}

function toChatMessage(row: StoredMessage): ChatMessage {
  return { id: row.id, role: row.role, text: row.body, at: row.created_at, suggestions: row.suggestions ?? [] };
}

export default function SuggestionsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading suggestions…</p>}>
      <Suggestions />
    </Suspense>
  );
}

function Suggestions() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tenantId, setTenantId] = useState(searchParams?.get("tenant") ?? "");
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SuggestionSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [prefill, setPrefill] = useState<{ id: number; text: string } | null>(null);

  const guard = useCallback(async (setBusy: (busy: boolean) => void, work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  function markBusy(ids: string[], busy: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (busy) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function replaceSuggestions(rows: GrowthSuggestion[]) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    setMessages((current) =>
      current.map((message) =>
        message.suggestions?.some((suggestion) => byId.has(suggestion.id))
          ? {
              ...message,
              suggestions: message.suggestions.map((suggestion) => byId.get(suggestion.id) ?? suggestion),
            }
          : message,
      ),
    );
  }

  function appendTurn(payload: { session_id?: string; messages?: StoredMessage[] }, replacePendingId?: string) {
    if (payload.session_id) setSessionId(payload.session_id);
    const stored = (payload.messages ?? []).map(toChatMessage);
    setMessages((current) => [
      ...current.filter((message) => message.id !== replacePendingId),
      ...stored,
    ]);
  }

  function pickTenant(id: string) {
    setTenantId(id);
    tenantIdRef.current = id;
    setSessionId(null);
    setSessions([]);
    setMessages([]);
    setBusyIds(new Set());
    setError(null);
    setPrefill(null);
    setEditor(null);
    router.replace(id ? `/suggestions?tenant=${encodeURIComponent(id)}` : "/suggestions");
  }

  function send(text: string) {
    const forTenant = tenantId;
    const pendingId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      { id: pendingId, role: "staff", text, at: new Date().toISOString() },
    ]);
    return guard(setSending, async () => {
      try {
        const payload = await request("/api/admin/suggestions/generate", {
          method: "POST",
          body: JSON.stringify({ tenant_id: forTenant, notes: text, session_id: sessionId }),
        });
        if (tenantIdRef.current !== forTenant) return;
        appendTurn(payload, pendingId);
      } catch (caught) {
        if (tenantIdRef.current === forTenant) {
          setMessages((current) => current.filter((message) => message.id !== pendingId));
          setPrefill({ id: Date.now(), text });
        }
        throw caught;
      }
    });
  }

  function pushIds(ids: string[]) {
    const forTenant = tenantId;
    return guard(
      (busy) => markBusy(ids, busy),
      async () => {
        const payload =
          ids.length === 1
            ? await request(`/api/admin/suggestions/${ids[0]}/push`, {
                method: "POST",
                body: JSON.stringify({ tenant_id: forTenant }),
              })
            : await request("/api/admin/suggestions/push-batch", {
                method: "POST",
                body: JSON.stringify({ tenant_id: forTenant, suggestion_ids: ids }),
              });
        if (tenantIdRef.current !== forTenant) return;
        replaceSuggestions((payload.suggestions ?? []) as GrowthSuggestion[]);
      },
    );
  }

  function archive(suggestion: GrowthSuggestion) {
    const forTenant = tenantId;
    return guard(
      (busy) => markBusy([suggestion.id], busy),
      async () => {
        const payload = await request(`/api/admin/suggestions/${suggestion.id}/archive`, {
          method: "POST",
          body: JSON.stringify({ tenant_id: forTenant }),
        });
        if (tenantIdRef.current !== forTenant) return;
        replaceSuggestions([{ ...suggestion, ...(payload.suggestion as GrowthSuggestion) }]);
      },
    );
  }

  function loadSessions() {
    if (!tenantId) return;
    void guard(setHistoryLoading, async () => {
      const payload = await request(
        `/api/admin/suggestions/sessions?tenant_id=${encodeURIComponent(tenantId)}`,
      );
      setSessions((payload.sessions ?? []) as SuggestionSession[]);
    });
  }

  function openSession(id: string) {
    const forTenant = tenantId;
    if (id === sessionId) return;
    setMessages([]);
    setSessionId(id);
    return guard(setSessionLoading, async () => {
      const payload = await request(
        `/api/admin/suggestions/sessions/${id}?tenant_id=${encodeURIComponent(forTenant)}`,
      );
      if (tenantIdRef.current !== forTenant) return;
      setMessages(((payload.messages ?? []) as StoredMessage[]).map(toChatMessage));
    });
  }

  function newSession() {
    setSessionId(null);
    setMessages([]);
    setError(null);
  }

  function saveEditor(value: SuggestionEditorValue) {
    if (!editor) return;
    const forTenant = tenantId;
    return guard(setEditorBusy, async () => {
      if (editor.mode === "create") {
        const payload = await request("/api/admin/suggestions", {
          method: "POST",
          body: JSON.stringify({ tenant_id: forTenant, session_id: sessionId, ...value }),
        });
        if (tenantIdRef.current !== forTenant) return;
        appendTurn(payload);
      } else {
        const payload = await request(`/api/admin/suggestions/${editor.suggestion.id}`, {
          method: "PATCH",
          body: JSON.stringify(value),
        });
        if (tenantIdRef.current !== forTenant) return;
        replaceSuggestions([{ ...editor.suggestion, ...(payload.suggestion as GrowthSuggestion) }]);
      }
      setEditor(null);
    });
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <ChatPanel
        tenantId={tenantId}
        onTenantChange={pickTenant}
        messages={messages}
        sending={sending}
        loadingSession={sessionLoading}
        error={error}
        onSend={(text) => void send(text)}
        onAddManual={() => setEditor({ mode: "create" })}
        actions={{
          busyIds,
          onEdit: (suggestion) => setEditor({ mode: "edit", suggestion }),
          onArchive: (suggestion) => void archive(suggestion),
          onPush: (suggestion) => void pushIds([suggestion.id]),
          onPushAll: (drafts) => void pushIds(drafts.map((suggestion) => suggestion.id)),
        }}
        history={{
          sessions,
          loading: historyLoading,
          activeId: sessionId,
          onOpen: loadSessions,
          onSelect: (id) => void openSession(id),
          onNew: newSession,
        }}
        prefill={prefill}
      />

      <Workspace tenantId={tenantId} onPrefill={(text) => setPrefill({ id: Date.now(), text })} />

      {editor && (
        <SuggestionEditorModal
          mode={editor.mode}
          initial={
            editor.mode === "edit"
              ? {
                  title: editor.suggestion.title,
                  body: editor.suggestion.body,
                  category: editor.suggestion.category,
                  priority: editor.suggestion.priority,
                }
              : undefined
          }
          busy={editorBusy}
          onClose={() => {
            if (!editorBusy) setEditor(null);
          }}
          onSave={(value) => void saveEditor(value)}
        />
      )}
    </div>
  );
}
