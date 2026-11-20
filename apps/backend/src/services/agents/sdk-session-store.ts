
import type {
  SessionStore,
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

export type SdkSessionScope = {
  runId: string;
  tenantId: string;
  threadId: string;
};

export interface SessionStoreDb {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ error: { message?: string; code?: string } | null }>;
  from(table: string): SessionStoreSelect;
}
export interface SessionStoreSelect {
  select(cols: string): SessionStoreFilter;
}
export interface SessionStoreFilter {
  eq(col: string, val: unknown): SessionStoreFilter;
  order(
    col: string,
    opts: { ascending: boolean },
  ): Promise<{ data: Array<{ entry: unknown }> | null; error: { message?: string } | null }>;
}

export class SessionScopeError extends Error {}

export const SESSION_PURGED_CODE = "ZSP01";

export function assertSessionScope(
  key: SessionKey,
  scope: SdkSessionScope,
): void {
  if (!key || typeof key.sessionId !== "string" || key.sessionId.length === 0) {
    throw new SessionScopeError(
      `sdk-session-store: invalid/empty sessionId run=${scope.runId}`,
    );
  }
}

export function shouldUseDurableResume(args: {
  isChatMode: boolean;
  durableEnabled: boolean;
  sdkSessionId: unknown;
  mirrorDegradedAt: unknown;
}): boolean {
  if (!args.durableEnabled || !args.isChatMode) return false;
  if (typeof args.sdkSessionId !== "string" || args.sdkSessionId.length === 0)
    return false;
  if (args.mirrorDegradedAt != null) return false;
  return true;
}

export function assertResumeFlagsSane(env: NodeJS.ProcessEnv): void {
  const legacyOn = env.PRAXIS_CHAT_SDK_RESUME === "1";
  const durableOn = env.PRAXIS_CHAT_SDK_RESUME_DURABLE !== "0";
  if (legacyOn && durableOn) {
    throw new Error(
      "PRAXIS_CHAT_SDK_RESUME (legacy ephemeral-disk) is on while durable resume " +
        "is also on (default). They are mutually exclusive — set " +
        "PRAXIS_CHAT_SDK_RESUME_DURABLE=0 to use the legacy gate, or unset " +
        "PRAXIS_CHAT_SDK_RESUME.",
    );
  }
}

export function toSessionKeyString(key: SessionKey): string {
  return key.subpath ? `${key.sessionId}::${key.subpath}` : key.sessionId;
}

export function createSdkSessionStore(
  scope: SdkSessionScope,
  db: SessionStoreDb,
): SessionStore {
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      assertSessionScope(key, scope);
      const session_key = toSessionKeyString(key);
      const { error } = await db.rpc("sdk_session_append", {
        p_tenant: scope.tenantId,
        p_thread: scope.threadId,
        p_project_key:
          typeof key.projectKey === "string" ? key.projectKey : "unknown",
        p_session_key: session_key,
        p_entries: entries ?? [],
      });
      if (error) {
        if (error.code === SESSION_PURGED_CODE) {
          console.warn(`[sdk-session-store] session purged by retention, append dropped (run=${scope.runId})`);
          return;
        }
        throw new Error(
          `sdk_session_append failed (run=${scope.runId}): ${error.message ?? "unknown"}`,
        );
      }
    },

    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      assertSessionScope(key, scope);
      const session_key = toSessionKeyString(key);
      const { data, error } = await db
        .from("sdk_session_entries")
        .select("entry")
        .eq("tenant_id", scope.tenantId)
        .eq("thread_id", scope.threadId)
        .eq("session_key", session_key)
        .order("position", { ascending: true });
      if (error) {
        throw new Error(
          `sdk_session_load failed (run=${scope.runId}): ${error.message ?? "unknown"}`,
        );
      }
      if (!data || data.length === 0) return null;
      return data.map((r) => r.entry as SessionStoreEntry);
    },
  };
}
