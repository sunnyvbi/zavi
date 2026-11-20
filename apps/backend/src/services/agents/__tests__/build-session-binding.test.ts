
import { describe, it, expect } from "vitest";
import {
  buildSessionOfPayload,
  buildSessionOfRun,
  buildSessionOfThread,
  isOwnedBuildSession,
  mustForkThread,
  type BindingDb,
} from "@/services/agents/build-session-binding";

const OWN = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>, opts: { error?: string } = {}) {
  const seen: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const nots: string[] = [];
      const q = {
        eq(col: string, v: unknown) {
          filters[col] = v;
          return q;
        },
        not(col: string) {
          nots.push(col);
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        async maybeSingle() {
          seen.push({ table, filters: { ...filters } });
          if (opts.error) return { data: null, error: { message: opts.error } };
          const match = (tables[table] ?? []).find((r) =>
            Object.entries(filters).every(([k, v]) => {
              if (k === "payload->>thread_id") return (r.payload as Row | undefined)?.thread_id === v;
              return r[k] === v;
            }) && nots.every((k) => (k === "payload->>build_session_id" ? (r.payload as Row | undefined)?.build_session_id != null : true)),
          );
          return { data: match ?? null, error: null };
        },
      };
      return { select: () => q };
    },
  } as unknown as BindingDb;
  return { db, seen };
}

describe("isOwnedBuildSession", () => {
  const runs = [
    { id: OWN, tenant_id: "t-own", kind: "build_app" },
    { id: OTHER, tenant_id: "t-other", kind: "build_app" },
  ];
  it("accepts this tenant's build session", async () => {
    const { db, seen } = fakeDb({ conductor_runs: runs });
    expect(await isOwnedBuildSession(db, "t-own", OWN)).toBe(true);
    expect(seen[0].filters).toMatchObject({ id: OWN, tenant_id: "t-own", kind: "build_app" });
  });
  it("refuses another tenant's build session", async () => {
    const { db } = fakeDb({ conductor_runs: runs });
    expect(await isOwnedBuildSession(db, "t-own", OTHER)).toBe(false);
  });
  it("refuses a non-uuid without a read", async () => {
    const { db, seen } = fakeDb({ conductor_runs: runs });
    expect(await isOwnedBuildSession(db, "t-own", "not-a-uuid")).toBe(false);
    expect(seen).toHaveLength(0);
  });
  it("throws on a read error (the caller decides, never a silent pass)", async () => {
    const { db } = fakeDb({ conductor_runs: runs }, { error: "db down" });
    await expect(isOwnedBuildSession(db, "t-own", OWN)).rejects.toThrow(/db down/);
  });
});

describe("buildSessionOfRun / buildSessionOfThread", () => {
  it("reads the run's own payload, tenant-scoped", async () => {
    const { db, seen } = fakeDb({
      agent_runs: [{ id: "run-1", tenant_id: "t-own", payload: { thread_id: "th", build_session_id: OWN } }],
    });
    expect(await buildSessionOfRun(db, "t-own", "run-1")).toBe(OWN);
    expect(seen[0].filters).toMatchObject({ id: "run-1", tenant_id: "t-own" });
    expect(await buildSessionOfRun(db, "t-other", "run-1")).toBeNull();
  });
  it("a thread's binding is its latest build-bound run", async () => {
    const { db } = fakeDb({
      agent_runs: [{ id: "run-1", tenant_id: "t-own", payload: { thread_id: "th-1", build_session_id: OWN } }],
    });
    expect(await buildSessionOfThread(db, "t-own", "th-1")).toBe(OWN);
    expect(await buildSessionOfThread(db, "t-own", "th-2")).toBeNull();
  });
});

describe("mustForkThread", () => {
  it("forks only when the thread already belongs to a different build", () => {
    expect(mustForkThread(OWN, OTHER)).toBe(true);
    expect(mustForkThread(OWN, OWN.toUpperCase())).toBe(false);
    expect(mustForkThread(OWN, null)).toBe(false);
    expect(mustForkThread(null, OTHER)).toBe(false);
  });
  it("buildSessionOfPayload ignores junk", () => {
    expect(buildSessionOfPayload({ build_session_id: "x" })).toBeNull();
    expect(buildSessionOfPayload(null)).toBeNull();
    expect(buildSessionOfPayload({ build_session_id: OWN.toUpperCase() })).toBe(OWN);
  });
});
