import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

const rpc = vi.hoisted(() => ({ tenantRpc: vi.fn(), note: vi.fn(async (..._a: unknown[]) => true) }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: rpc.tenantRpc }));
vi.mock("@/services/build/build-ready-message", () => ({ postBuildChatNote: rpc.note }));

import { logEvent } from "@/services/logging/logEvent";
import {
  QUEUED_CHANGE_DROPPED_CHAT,
  QUEUED_CHANGE_FAILED_CHAT,
  QUEUED_CHANGE_STARTED_CHAT,
  drainQueuedSiteChange,
  dropHeldChanges,
  realQueuedChangeStore,
  type DrainDeps,
  type QueuedChangeStore,
} from "../queued-change";

const T = "11111111-1111-4111-8111-111111111111";
const SITE = "33333333-3333-4333-8333-333333333333";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const EDIT = "aaaaaaaa-0000-4000-8000-000000000009";

class Busy extends Error {}

function world(held: boolean) {
  const row = { status: held ? "queued" : "none" };
  const log: string[] = [];
  const store: QueuedChangeStore = {
    queue: async () => "queued",
    claim: async (t) => {
      log.push(`claim:${t}`);
      if (row.status !== "queued") return null;
      row.status = "running";
      return { site_id: SITE, conductor_run_id: SESSION, message: "Add our prices: $80 a clean" };
    },
    settle: async (_t, _s, requeue) => {
      log.push(`settle:${requeue}`);
      row.status = requeue ? "queued" : "none";
    },
    dropStopped: async () => [],
  };
  const notes: Array<{ tenant: string; session: string; body: string }> = [];
  const deps: DrainDeps = {
    store,
    refine: vi.fn(async () => ({ conductor_run_id: EDIT })),
    tick: vi.fn(async () => undefined),
    isBusy: (e) => e instanceof Busy,
    notify: async (tenant, session, body) => void notes.push({ tenant, session, body }),
  };
  return { row, log, deps, notes };
}

describe("drainQueuedSiteChange", () => {
  it("starts the held change on the site's own session, kicks it and tells the owner in that chat", async () => {
    const w = world(true);
    const out = await drainQueuedSiteChange(T, w.deps);
    expect(out).toEqual({ kind: "started", site_id: SITE, conductor_run_id: EDIT });
    expect(w.deps.refine).toHaveBeenCalledWith({ tenant_id: T, message: "Add our prices: $80 a clean", conductor_run_id: SESSION });
    expect(w.deps.tick).toHaveBeenCalledWith(EDIT);
    expect(w.row.status).toBe("none");
    expect(w.notes).toEqual([{ tenant: T, session: SESSION, body: QUEUED_CHANGE_STARTED_CHAT }]);
  });

  it("another build still holding the slot puts the change back, untouched, for the next finish", async () => {
    const w = world(true);
    (w.deps.refine as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Busy());
    expect(await drainQueuedSiteChange(T, w.deps)).toEqual({ kind: "still_busy", site_id: SITE });
    expect(w.row.status).toBe("queued");
    expect(w.notes).toEqual([]);
    expect(w.deps.tick).not.toHaveBeenCalled();
    expect((await drainQueuedSiteChange(T, w.deps)).kind).toBe("started");
    expect(w.deps.refine).toHaveBeenCalledTimes(2);
  });

  it("a refused change is dropped (never retried into a second charge) and the owner is told why", async () => {
    const w = world(true);
    (w.deps.refine as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("no credits"), { name: "InsufficientCreditsForBuild" }));
    w.deps.failureChat = () => "You're out of credits for changes.";
    const out = await drainQueuedSiteChange(T, w.deps);
    expect(out).toEqual({ kind: "failed", site_id: SITE, code: "InsufficientCreditsForBuild" });
    expect(w.row.status).toBe("none");
    expect(w.notes[0]!.body).toBe(`${QUEUED_CHANGE_FAILED_CHAT} You're out of credits for changes.`);
    expect(await drainQueuedSiteChange(T, w.deps)).toEqual({ kind: "empty" });
    expect(w.deps.refine).toHaveBeenCalledTimes(1);
  });

  it("nothing held: no refine, no note", async () => {
    const w = world(false);
    expect(await drainQueuedSiteChange(T, w.deps)).toEqual({ kind: "empty" });
    expect(w.deps.refine).not.toHaveBeenCalled();
    expect(w.notes).toEqual([]);
  });

  it("a failing chat note or tick never undoes a started change", async () => {
    const w = world(true);
    w.deps.notify = async () => {
      throw new Error("thread down");
    };
    (w.deps.tick as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("inngest down"));
    expect((await drainQueuedSiteChange(T, w.deps)).kind).toBe("started");
    expect(w.log).toEqual([`claim:${T}`, "settle:false"]);
  });
});

describe("drainQueuedSiteChange with a change whose build stopped", () => {
  it("tells each owner in their own chat before it claims the next change", async () => {
    const w = world(true);
    w.deps.store.dropStopped = async () => {
      w.log.push("dropStopped");
      return ["root-1", "root-2"];
    };
    await drainQueuedSiteChange(T, w.deps);
    expect(w.log[0]).toBe("dropStopped");
    expect(w.notes.filter((n) => n.body === QUEUED_CHANGE_DROPPED_CHAT)).toEqual([
      { tenant: T, session: "root-1", body: QUEUED_CHANGE_DROPPED_CHAT },
      { tenant: T, session: "root-2", body: QUEUED_CHANGE_DROPPED_CHAT },
    ]);
  });

  it("a failed note for one owner still reaches the other and does not stop the next change", async () => {
    const w = world(true);
    w.deps.store.dropStopped = async () => ["root-1", "root-2"];
    const notify = w.deps.notify;
    w.deps.notify = async (tenant, session, body) => {
      if (session === "root-1") throw new Error("thread down");
      return notify(tenant, session, body);
    };
    vi.mocked(logEvent).mockClear();
    expect((await drainQueuedSiteChange(T, w.deps)).kind).toBe("started");
    expect(w.notes.map((n) => n.session)).toContain("root-2");
    expect(vi.mocked(logEvent).mock.calls.map((c) => (c[0] as { code: string }).code)).toContain("queued_site_change_drop_failed");
  });

  it("logs a dropped change whose owner has no chat thread, without stopping the next change", async () => {
    const w = world(true);
    w.deps.store.dropStopped = async () => ["root-1", "root-2"];
    w.deps.notify = async (_tenant, session) => session === "root-2";
    vi.mocked(logEvent).mockClear();
    expect((await drainQueuedSiteChange(T, w.deps)).kind).toBe("started");
    const logged = vi.mocked(logEvent).mock.calls.map((c) => c[0] as { code: string; error?: Error });
    const drop = logged.find((entry) => entry.code === "queued_site_change_drop_failed");
    expect(drop?.error?.message).toBe("No chat thread for a dropped change");
  });

  it("does not log a dropped change when every owner got the note", async () => {
    const w = world(true);
    w.deps.store.dropStopped = async () => ["root-1", "root-2"];
    vi.mocked(logEvent).mockClear();
    await drainQueuedSiteChange(T, w.deps);
    expect(vi.mocked(logEvent).mock.calls.map((c) => (c[0] as { code: string }).code)).not.toContain("queued_site_change_drop_failed");
  });

  it("a failed drop still lets the next held change run", async () => {
    const w = world(true);
    w.deps.store.dropStopped = async () => {
      throw new Error("rpc down");
    };
    expect((await drainQueuedSiteChange(T, w.deps)).kind).toBe("started");
  });
});

describe("realQueuedChangeStore.dropStopped", () => {
  it("returns the sessions the database dropped for this tenant", async () => {
    rpc.tenantRpc.mockResolvedValueOnce({ data: ["root-1"], error: null });
    expect(await realQueuedChangeStore.dropStopped(T)).toEqual(["root-1"]);
    expect(rpc.tenantRpc).toHaveBeenCalledWith(T, "site_drop_stopped_queued_changes", {});
  });

  it("throws when the database refuses", async () => {
    rpc.tenantRpc.mockResolvedValueOnce({ data: null, error: { message: "nope" } });
    await expect(realQueuedChangeStore.dropStopped(T)).rejects.toThrow("site_drop_stopped_queued_changes failed: nope");
  });
});

describe("dropHeldChanges", () => {
  it("tells each site's owner in the root session, not on the stopped refine", async () => {
    rpc.note.mockClear();
    rpc.note.mockRejectedValueOnce(new Error("chat down"));
    rpc.tenantRpc.mockResolvedValueOnce({ data: ["root-1", "root-2"], error: null });
    expect(await dropHeldChanges(T, "refine-1")).toBe(2);
    expect(rpc.tenantRpc).toHaveBeenCalledWith(T, "site_discard_queued_change", { p_conductor_run_id: "refine-1" });
    expect(rpc.note.mock.calls.map((c) => c[0])).toEqual([
      { tenant_id: T, conductor_run_id: "root-1", body: QUEUED_CHANGE_DROPPED_CHAT },
      { tenant_id: T, conductor_run_id: "root-2", body: QUEUED_CHANGE_DROPPED_CHAT },
    ]);
  });

  it("says nothing when nothing was held", async () => {
    rpc.note.mockClear();
    rpc.tenantRpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await dropHeldChanges(T, "refine-1")).toBe(0);
    expect(rpc.note).not.toHaveBeenCalled();
  });
});
