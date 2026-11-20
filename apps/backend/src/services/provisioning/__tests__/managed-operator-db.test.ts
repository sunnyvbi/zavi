import { describe, expect, it, vi } from "vitest";
import {
  ensureManagedOperatorDb,
  MANAGED_RO_ROLE,
  readOnlyUri,
  refreshManagedOperatorDbAfterDeploy,
  type ManagedOperatorDbDeps,
} from "../managed-operator-db";

const OWNER = "postgresql://neondb_owner:ownerpw@ep-x-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require";
const PW = "a".repeat(48);

function deps(over: Partial<ManagedOperatorDbDeps> = {}): ManagedOperatorDbDeps {
  return {
    isEnabled: vi.fn(async () => true),
    readDbRow: vi.fn(async () => ({ mode: "provisioned", status: "ready", vault_key: "db.connection_uri" })),
    readOperatorDb: vi.fn(async () => undefined),
    isOptedOut: vi.fn(async () => false),
    getSecret: vi.fn(async () => OWNER),
    grantReadOnlyRole: vi.fn(async () => undefined),
    verifyReadOnly: vi.fn(async () => true),
    probe: vi.fn(async () => true),
    store: vi.fn(async () => true),
    enqueueDiscovery: vi.fn(async () => undefined),
    newPassword: () => PW,
    withAppDbLock: vi.fn(async (_uri, fn) => fn()) as ManagedOperatorDbDeps["withAppDbLock"],
    ...over,
  };
}

describe("readOnlyUri", () => {
  it("swaps only the user and password", () => {
    const u = new URL(readOnlyUri(OWNER, MANAGED_RO_ROLE, PW));
    expect(u.username).toBe(MANAGED_RO_ROLE);
    expect(u.password).toBe(PW);
    expect(u.host).toBe("ep-x-pooler.us-west-2.aws.neon.tech");
    expect(u.pathname).toBe("/neondb");
    expect(u.searchParams.get("sslmode")).toBe("require");
  });
});

describe("ensureManagedOperatorDb", () => {
  it("an admin's disconnect opt-out is honoured: no role is created or rotated, nothing stored", async () => {
    const d = deps({ isOptedOut: vi.fn(async () => true) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("opted_out");
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
    expect(d.store).not.toHaveBeenCalled();
    expect(d.enqueueDiscovery).not.toHaveBeenCalled();
  });

  it("an opt-out that lands while waiting for the lock still stops it", async () => {
    const isOptedOut = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const d = deps({ isOptedOut });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("opted_out");
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
  });

  it("the deploy refresh never reconnects an opted-out database", async () => {
    const d = deps({ isOptedOut: vi.fn(async () => true) });
    expect(await refreshManagedOperatorDbAfterDeploy("t1", d)).toBe("opted_out");
    expect(d.store).not.toHaveBeenCalled();
  });

  it("creates the read-only role, verifies it, stores it and enqueues discovery", async () => {
    const d = deps();
    expect(await ensureManagedOperatorDb("t1", d)).toBe("connected");
    expect(d.grantReadOnlyRole).toHaveBeenCalledWith(OWNER, MANAGED_RO_ROLE, PW);
    const stored = (d.store as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(stored[0]).toBe("t1");
    expect(new URL(stored[1]).username).toBe(MANAGED_RO_ROLE);
    expect(stored[1]).not.toContain("ownerpw");
    expect(d.enqueueDiscovery).toHaveBeenCalledWith("t1");
  });

  it("does not rotate a password another attempt stored while it waited for the lock", async () => {
    const readOperatorDb = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ managed_by: "zavi" });
    const d = deps({ readOperatorDb });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("already_connected");
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
    expect(d.store).not.toHaveBeenCalled();
  });

  it("rotates, verifies and stores inside the app-database lock", async () => {
    const order: string[] = [];
    const d = deps({
      withAppDbLock: (async (_uri: string, fn: () => Promise<unknown>) => {
        order.push("lock");
        const r = await fn();
        order.push("unlock");
        return r;
      }) as ManagedOperatorDbDeps["withAppDbLock"],
      grantReadOnlyRole: vi.fn(async () => { order.push("grant"); }),
      store: vi.fn(async () => { order.push("store"); return true; }),
    });
    await ensureManagedOperatorDb("t1", d);
    expect(order).toEqual(["lock", "grant", "store", "unlock"]);
  });

  it("re-checks the kill switch after waiting for the lock", async () => {
    const isEnabled = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const d = deps({ isEnabled });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("disabled");
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
    expect(d.store).not.toHaveBeenCalled();
  });

  it("never touches a founder-connected database", async () => {
    const d = deps({ readOperatorDb: vi.fn(async () => ({ managed_by: null })) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("founder_connected");
    expect(d.getSecret).not.toHaveBeenCalled();
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
    expect(d.store).not.toHaveBeenCalled();
  });

  it("is a cheap no-op once Zavi has connected it (no Neon or pg work)", async () => {
    const d = deps({ readOperatorDb: vi.fn(async () => ({ managed_by: "zavi" })) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("already_connected");
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
    expect(d.store).not.toHaveBeenCalled();
  });

  it("does nothing when the kill switch is off", async () => {
    const d = deps({ isEnabled: vi.fn(async () => false) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("disabled");
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{ mode: "connected", status: "ready", vault_key: "db.connection_uri" }],
    [{ mode: "provisioned", status: "failed", vault_key: "db.connection_uri" }],
    [{ mode: "provisioned", status: "ready", vault_key: null }],
  ])("does nothing without a ready Zavi-provisioned database (%j)", async (row) => {
    const d = deps({ readDbRow: vi.fn(async () => row) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("no_app_db");
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
  });

  it("refuses to store a credential that is not provably read-only", async () => {
    const d = deps({ verifyReadOnly: vi.fn(async () => false) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("not_read_only");
    expect(d.store).not.toHaveBeenCalled();
  });

  it("does not store an unreachable credential", async () => {
    const d = deps({ probe: vi.fn(async () => false) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("unreachable");
    expect(d.store).not.toHaveBeenCalled();
  });

  it("reports a DB refusal and enqueues nothing", async () => {
    const d = deps({ store: vi.fn(async () => false) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("refused");
    expect(d.enqueueDiscovery).not.toHaveBeenCalled();
  });

  it("a lost discovery enqueue still counts as connected, and logs no credential", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d = deps({ enqueueDiscovery: vi.fn(async () => { throw new Error("inngest down"); }) });
    expect(await ensureManagedOperatorDb("t1", d)).toBe("connected");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain(PW);
    expect(logged).not.toContain("ownerpw");
    warn.mockRestore();
  });
});

describe("refreshManagedOperatorDbAfterDeploy", () => {
  it("re-discovers an existing Zavi-managed connection", async () => {
    const d = deps({ readOperatorDb: vi.fn(async () => ({ managed_by: "zavi" })) });
    expect(await refreshManagedOperatorDbAfterDeploy("t1", d)).toBe("rediscovering");
    expect(d.enqueueDiscovery).toHaveBeenCalledWith("t1");
    expect(d.grantReadOnlyRole).not.toHaveBeenCalled();
  });

  it("connects when an earlier attempt did not", async () => {
    const d = deps();
    expect(await refreshManagedOperatorDbAfterDeploy("t1", d)).toBe("connected");
    expect(d.enqueueDiscovery).toHaveBeenCalledTimes(1);
  });

  it("leaves a founder database alone", async () => {
    const d = deps({ readOperatorDb: vi.fn(async () => ({ managed_by: null })) });
    expect(await refreshManagedOperatorDbAfterDeploy("t1", d)).toBe("founder_connected");
    expect(d.enqueueDiscovery).not.toHaveBeenCalled();
  });

  it("does not re-discover when the kill switch is off", async () => {
    const d = deps({ readOperatorDb: vi.fn(async () => ({ managed_by: "zavi" })), isEnabled: vi.fn(async () => false) });
    expect(await refreshManagedOperatorDbAfterDeploy("t1", d)).toBe("disabled");
    expect(d.enqueueDiscovery).not.toHaveBeenCalled();
  });
});
