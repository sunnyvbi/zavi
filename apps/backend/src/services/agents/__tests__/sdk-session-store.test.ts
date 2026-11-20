
import { describe, it, expect } from "vitest";
import type { SessionKey } from "@anthropic-ai/claude-agent-sdk";
import {
  createSdkSessionStore,
  assertSessionScope,
  toSessionKeyString,
  shouldUseDurableResume,
  assertResumeFlagsSane,
  SessionScopeError,
  SESSION_PURGED_CODE,
  type SdkSessionScope,
  type SessionStoreDb,
} from "@/services/agents/sdk-session-store";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const THREAD_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const THREAD_A2 = "a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2";
const SDK_PROJECT_KEY = "cwd-derived-project";

function scopeA(): SdkSessionScope {
  return { runId: "run-A", tenantId: TENANT_A, threadId: THREAD_A };
}

function mockDb(loadData: Array<{ entry: unknown }> | null = null) {
  const calls: {
    rpc: Array<{ fn: string; args: Record<string, unknown> }>;
    loadFilters: Record<string, unknown> | null;
  } = { rpc: [], loadFilters: null };
  const db: SessionStoreDb = {
    async rpc(fn, args) {
      calls.rpc.push({ fn, args });
      return { error: null };
    },
    from() {
      const f: Record<string, unknown> = {};
      const builder = {
        eq(col: string, val: unknown) {
          f[col] = val;
          return builder;
        },
        order(col: string, _opts: { ascending: boolean }) {
          calls.loadFilters = { ...f, _order: col };
          return Promise.resolve({ data: loadData, error: null });
        },
      };
      return { select: () => builder };
    },
  };
  return { db, calls };
}

const key = (over: Partial<SessionKey> = {}): SessionKey => ({
  projectKey: SDK_PROJECT_KEY,
  sessionId: "sess-123",
  ...over,
});

describe("assertSessionScope", () => {
  it("does not trust or reject key.projectKey for tenant isolation", () => {
    expect(() => assertSessionScope(key({ projectKey: TENANT_B }), scopeA())).not.toThrow();
  });
  it("throws on empty/missing sessionId", () => {
    expect(() => assertSessionScope(key({ sessionId: "" }), scopeA())).toThrow(SessionScopeError);
  });
  it("passes with a usable sessionId", () => {
    expect(() => assertSessionScope(key(), scopeA())).not.toThrow();
  });
});

describe("createSdkSessionStore — append", () => {
  it("writes via the RPC scoped to the RUN's tenant/thread; projectKey is metadata", async () => {
    const { db, calls } = mockDb();
    const store = createSdkSessionStore(scopeA(), db);
    await store.append(key(), [{ type: "user", uuid: "u1" } as never]);
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].fn).toBe("sdk_session_append");
    expect(calls.rpc[0].args.p_tenant).toBe(TENANT_A);
    expect(calls.rpc[0].args.p_thread).toBe(THREAD_A);
    expect(calls.rpc[0].args.p_project_key).toBe(SDK_PROJECT_KEY);
    expect(calls.rpc[0].args.p_session_key).toBe("sess-123");
  });
  it("does not let key.projectKey alter the run-derived tenant/thread scope", async () => {
    const { db, calls } = mockDb();
    const store = createSdkSessionStore(scopeA(), db);
    await store.append(key({ projectKey: TENANT_B }), []);
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].args.p_tenant).toBe(TENANT_A);
    expect(calls.rpc[0].args.p_thread).toBe(THREAD_A);
    expect(calls.rpc[0].args.p_project_key).toBe(TENANT_B);
  });
});

describe("createSdkSessionStore — load", () => {
  it("filters by the RUN's tenant_id AND thread_id (not the key) + the key's session", async () => {
    const { db, calls } = mockDb([{ entry: { type: "user" } }]);
    const store = createSdkSessionStore(scopeA(), db);
    const out = await store.load(key());
    expect(calls.loadFilters).toMatchObject({
      tenant_id: TENANT_A,
      thread_id: THREAD_A,
      session_key: "sess-123",
      _order: "position",
    });
    expect(out).toEqual([{ type: "user" }]);
  });

  it("a forged sessionId cannot escape the run's thread scope (thread_id is always the run's)", async () => {
    const { db, calls } = mockDb([]);
    const store = createSdkSessionStore(scopeA(), db);
    await store.load(key({ sessionId: "stolen-other-thread-session" }));
    expect(calls.loadFilters!.thread_id).toBe(THREAD_A);
    expect(calls.loadFilters!.tenant_id).toBe(TENANT_A);
  });

  it("returns null for a never-written session (SDK contract)", async () => {
    const { db } = mockDb([]);
    const store = createSdkSessionStore(scopeA(), db);
    expect(await store.load(key())).toBeNull();
  });

  it("maps rows to entries in position order", async () => {
    const { db } = mockDb([{ entry: { type: "a" } }, { entry: { type: "b" } }]);
    const store = createSdkSessionStore(scopeA(), db);
    expect(await store.load(key())).toEqual([{ type: "a" }, { type: "b" }]);
  });
});

describe("toSessionKeyString", () => {
  it("plain sessionId for the main transcript", () => {
    expect(toSessionKeyString(key())).toBe("sess-123");
  });
  it("suffixes subpath for subagent files", () => {
    expect(toSessionKeyString(key({ subpath: "sub1" }))).toBe("sess-123::sub1");
  });
});

describe("shouldUseDurableResume (pre-flight)", () => {
  const base = {
    isChatMode: true,
    durableEnabled: true,
    sdkSessionId: "sess-1",
    mirrorDegradedAt: null as unknown,
  };
  it("true on the happy path", () => {
    expect(shouldUseDurableResume(base)).toBe(true);
  });
  it("false when the flag is off", () => {
    expect(shouldUseDurableResume({ ...base, durableEnabled: false })).toBe(false);
  });
  it("false on a non-chat run", () => {
    expect(shouldUseDurableResume({ ...base, isChatMode: false })).toBe(false);
  });
  it("false on turn 1 (no sdk_session_id)", () => {
    expect(shouldUseDurableResume({ ...base, sdkSessionId: null })).toBe(false);
  });
  it("false when the session is mirror-degraded (P0 floor)", () => {
    expect(
      shouldUseDurableResume({ ...base, mirrorDegradedAt: "2026-06-15T00:00:00Z" }),
    ).toBe(false);
  });
});

describe("assertResumeFlagsSane (startup invariant)", () => {
  it("throws when BOTH legacy and durable resume are enabled", () => {
    expect(() =>
      assertResumeFlagsSane({
        PRAXIS_CHAT_SDK_RESUME: "1",
        PRAXIS_CHAT_SDK_RESUME_DURABLE: "1",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
  it("ok when only durable is on", () => {
    expect(() =>
      assertResumeFlagsSane({ PRAXIS_CHAT_SDK_RESUME_DURABLE: "1" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
  it("ok when neither is explicitly set (durable default-on, legacy off)", () => {
    expect(() => assertResumeFlagsSane({} as NodeJS.ProcessEnv)).not.toThrow();
  });
  it("throws when legacy is on and durable is left at its default (on)", () => {
    expect(() =>
      assertResumeFlagsSane({ PRAXIS_CHAT_SDK_RESUME: "1" } as NodeJS.ProcessEnv),
    ).toThrow();
  });
  it("ok when legacy is on AND durable is explicitly disabled (=0)", () => {
    expect(() =>
      assertResumeFlagsSane({
        PRAXIS_CHAT_SDK_RESUME: "1",
        PRAXIS_CHAT_SDK_RESUME_DURABLE: "0",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe("createSdkSessionStore — append to a session the retention purge removed", () => {
  function dbWithAppendError(error: { message?: string; code?: string }): SessionStoreDb {
    return {
      rpc: async () => ({ error }),
      from: () => {
        const b = { eq: () => b, order: async () => ({ data: null, error: null }) };
        return { select: () => b };
      },
    };
  }
  it("drops the entries quietly (no throw, so no mirror_error and no degraded thread)", async () => {
    const store = createSdkSessionStore(scopeA(), dbWithAppendError({ message: "session was purged", code: SESSION_PURGED_CODE }));
    await expect(store.append(key(), [{ type: "user", uuid: "u1" } as never])).resolves.toBeUndefined();
  });
  it("any other append error still throws", async () => {
    const store = createSdkSessionStore(scopeA(), dbWithAppendError({ message: "boom", code: "40001" }));
    await expect(store.append(key(), [{ type: "user", uuid: "u1" } as never])).rejects.toThrow(/sdk_session_append failed/);
  });
});
