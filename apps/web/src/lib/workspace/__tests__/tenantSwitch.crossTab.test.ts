// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ status: 200, converged: true, throws: false }));
vi.mock("@/lib/api", () => ({
  apiFetch: async () => {
    if (server.throws) throw new Error("network");
    return { ok: server.status < 400, status: server.status } as Response;
  },
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/browser-tenant", () => ({ writeStoredTenant: async () => {} }));
vi.mock("@/lib/ensure-tenant-claim", () => ({ refreshSessionUntilClaim: async () => server.converged }));
vi.mock("@/lib/active-tenant-client", () => ({ clearActiveTenantCache: () => {} }));

type TabModule = typeof import("../tenantSwitch");

class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    FakeBroadcastChannel.open.add(this);
  }
  postMessage(data: unknown) {
    const payload = structuredClone(data);
    for (const other of FakeBroadcastChannel.open) {
      if (other === this || other.name !== this.name) continue;
      setTimeout(() => other.onmessage?.({ data: payload }), 0);
    }
  }
  close() {
    FakeBroadcastChannel.open.delete(this);
  }
}

async function openTab(): Promise<TabModule> {
  vi.resetModules();
  return import("../tenantSwitch");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const stops: Array<() => void> = [];
let storageWrites: Array<{ key: string; value: string }> = [];

beforeEach(() => {
  server.status = 200;
  server.converged = true;
  server.throws = false;
  storageWrites = [];
  FakeBroadcastChannel.open.clear();
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  const realSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    storageWrites.push({ key, value });
    realSetItem.call(this, key, value);
  });
});

afterEach(() => {
  while (stops.length) stops.pop()!();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function twoTabs() {
  const tab1 = await openTab();
  const tab2 = await openTab();
  const reload1 = vi.fn();
  const reload2 = vi.fn();
  stops.push(tab1.listenForTenantSwitches(reload1), tab2.listenForTenantSwitches(reload2));
  return { tab1, tab2, reload1, reload2 };
}

function deliverStorageWritesToEveryTab() {
  for (const { key, value } of storageWrites) {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: window.localStorage }));
  }
}

describe("tenant switch across tabs (BroadcastChannel)", () => {
  it("a completed switch in tab 1 reloads tab 2 once and never reloads tab 1 from its own broadcast", async () => {
    const { tab1, reload1, reload2 } = await twoTabs();
    expect(await tab1.switchToTenantDetailed("B")).toBe("ok");
    await settle();
    expect(reload2).toHaveBeenCalledTimes(1);
    expect(reload1).not.toHaveBeenCalled();
  });

  it("a switch the server made but the token never picked up still reloads tab 2", async () => {
    server.converged = false;
    const { tab1, reload1, reload2 } = await twoTabs();
    expect(await tab1.switchToTenantDetailed("B")).toBe("not_converged");
    await settle();
    expect(reload2).toHaveBeenCalledTimes(1);
    expect(reload1).not.toHaveBeenCalled();
  });

  it("a 500 after the POST (server may have switched) reloads tab 2", async () => {
    server.status = 500;
    const { tab1, reload2 } = await twoTabs();
    expect(await tab1.switchToTenantDetailed("B")).toBe("not_converged");
    await settle();
    expect(reload2).toHaveBeenCalledTimes(1);
  });

  it("a switch that throws mid-flight still reloads tab 2 and rethrows to the caller", async () => {
    server.throws = true;
    const { tab1, reload2 } = await twoTabs();
    await expect(tab1.switchToTenantDetailed("B")).rejects.toThrow("network");
    await settle();
    expect(reload2).toHaveBeenCalledTimes(1);
  });

  it("a refused switch changed nothing, so no tab reloads", async () => {
    server.status = 403;
    const { tab1, reload1, reload2 } = await twoTabs();
    expect(await tab1.switchToTenantDetailed("B")).toBe("refused");
    await settle();
    expect(reload1).not.toHaveBeenCalled();
    expect(reload2).not.toHaveBeenCalled();
    expect(storageWrites.filter((w) => w.key.includes("tenant-switched"))).toEqual([]);
  });

  it("with no custom handler the receiving tab reloads its page without the old workspace's build link", async () => {
    const reload = vi.fn();
    const replace = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, href: "https://www.zaviagent.com/workspace?tab=build&build=b1&buildThread=new", reload, replace },
    });
    try {
      const tab1 = await openTab();
      const tab2 = await openTab();
      stops.push(tab2.listenForTenantSwitches());
      await tab1.switchToTenantDetailed("B");
      await settle();
      expect(replace.mock.calls).toEqual([["https://www.zaviagent.com/workspace?tab=build"]]);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("a receiving tab on a settings #section with no build link really reloads", async () => {
    const reload = vi.fn();
    const replace = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, href: "https://www.zaviagent.com/workspace?tab=settings#team", reload, replace },
    });
    try {
      const tab1 = await openTab();
      const tab2 = await openTab();
      stops.push(tab2.listenForTenantSwitches());
      await tab1.switchToTenantDetailed("B");
      await settle();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(replace).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("a tab holding an unsaved review is not reloaded: it is told the company changed, and reloads once the review is closed", async () => {
    const reload = vi.fn();
    const replace = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, href: "https://www.zaviagent.com/workspace?tab=channels&channel=linkedin_ads", reload, replace },
    });
    try {
      const tab1 = await openTab();
      const tab2 = await openTab();
      stops.push(tab2.listenForTenantSwitches());
      const told = vi.fn();
      window.addEventListener(tab2.TENANT_SWITCHED_ELSEWHERE_EVENT, told);
      const release = tab2.holdReloadForUnsavedWork();
      const second = tab2.holdReloadForUnsavedWork();
      expect(tab2.tenantSwitchedElsewhere()).toBe(false);
      await tab1.switchToTenantDetailed("B");
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(told).toHaveBeenCalledTimes(1);
      expect(tab2.tenantSwitchedElsewhere()).toBe(true);
      expect(tab1.tenantSwitchedElsewhere()).toBe(false);
      release();
      release();
      expect(reload).not.toHaveBeenCalled();
      second();
      expect(reload).toHaveBeenCalledTimes(1);
      window.removeEventListener(tab2.TENANT_SWITCHED_ELSEWHERE_EVENT, told);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("must not catch: a hold released with no switch heard never reloads", async () => {
    const tab2 = await openTab();
    const reload = vi.spyOn(await import("../buildLinkOnLoad"), "reloadWithoutBuild").mockImplementation(() => {});
    stops.push(tab2.listenForTenantSwitches());
    tab2.holdReloadForUnsavedWork()();
    expect(reload).not.toHaveBeenCalled();
  });

  it("an unmounted listener no longer reloads", async () => {
    const tab1 = await openTab();
    const tab2 = await openTab();
    const reload2 = vi.fn();
    tab2.listenForTenantSwitches(reload2)();
    await tab1.switchToTenantDetailed("B");
    await settle();
    expect(reload2).not.toHaveBeenCalled();
  });
});

describe("tenant switch across tabs (storage-event fallback)", () => {
  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", undefined);
  });

  it("without BroadcastChannel, tab 2 reloads from the storage event and tab 1 ignores its own write", async () => {
    const { tab1, reload1, reload2 } = await twoTabs();
    expect(await tab1.switchToTenantDetailed("B")).toBe("ok");
    expect(reload2).not.toHaveBeenCalled();
    expect(storageWrites.length).toBeGreaterThan(0);
    deliverStorageWritesToEveryTab();
    deliverStorageWritesToEveryTab();
    expect(reload2).toHaveBeenCalledTimes(1);
    expect(reload1).not.toHaveBeenCalled();
  });

  it("without BroadcastChannel, a not-converged switch is also broadcast through storage", async () => {
    server.converged = false;
    const { tab1, reload1, reload2 } = await twoTabs();
    expect(await tab1.switchToTenantDetailed("B")).toBe("not_converged");
    deliverStorageWritesToEveryTab();
    expect(reload2).toHaveBeenCalledTimes(1);
    expect(reload1).not.toHaveBeenCalled();
  });

  it("a storage failure does not break the switch itself", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { tab1 } = await twoTabs();
    expect(await tab1.switchToTenantDetailed("B")).toBe("ok");
  });

  it("unrelated or garbage storage events never reload", async () => {
    const { reload2 } = await twoTabs();
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else", newValue: "{}" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "zavi:tenant-switched", newValue: "not json" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "zavi:tenant-switched", newValue: null }));
    expect(reload2).not.toHaveBeenCalled();
  });
});
