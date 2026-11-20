import { describe, it, expect, vi } from "vitest";
import {
  GOOGLE_ACCOUNT_BLOCKED_MARKER,
  googleAccountStatusWord,
  metaAccountStatusWord,
  noteGoogleAccountStatus,
  noteMetaAccountStatus,
  noteMetaReadiness,
  readAccountMarker,
  META_ACCOUNT_BLOCKED_MARKER,
  META_NOT_READY_MARKER,
  type MarkerDeps,
} from "../ad-account-watch";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-07T12:00:00.000Z");

function markers(initial: Record<string, number> = {}) {
  const store = new Map(Object.entries(initial));
  const alert = vi.fn(async () => undefined);
  const deps: MarkerDeps = {
    at: async (_t, b) => store.get(b) ?? null,
    stamp: async (_t, b, now) => {
      store.set(b, now.getTime());
    },
    clear: async (_t, b) => {
      store.delete(b);
    },
    alert,
  };
  return { store, alert, deps };
}

describe("metaAccountStatusWord", () => {
  it("an active account is fine; anything else is named", () => {
    expect(metaAccountStatusWord(1)).toBeNull();
    expect(metaAccountStatusWord("1")).toBeNull();
    expect(metaAccountStatusWord(2)).toBe("disabled");
    expect(metaAccountStatusWord("3")).toBe("unsettled");
    expect(metaAccountStatusWord(42)).toBe("status_42");
    expect(metaAccountStatusWord(undefined)).toBeNull();
  });
});

describe("noteMetaAccountStatus", () => {
  it("stamps the reason once when the account stops being active and tells the founder once", async () => {
    const m = markers();
    expect(await noteMetaAccountStatus(T, "act_1", 3, NOW, m.deps)).toBe("blocked");
    expect(await noteMetaAccountStatus(T, "act_1", 3, new Date(NOW.getTime() + 3_600_000), m.deps)).toBe("unchanged");
    expect(m.alert).toHaveBeenCalledTimes(1);
    expect(await readAccountMarker(T, META_ACCOUNT_BLOCKED_MARKER, m.deps)).toEqual({ since: NOW.toISOString(), reason: "unsettled" });
  });

  it("a status Zavi cannot name is kept as no reason; a new reason is a new episode", async () => {
    const m = markers();
    await noteMetaAccountStatus(T, "act_1", 42, NOW, m.deps);
    expect(await readAccountMarker(T, META_ACCOUNT_BLOCKED_MARKER, m.deps)).toEqual({ since: NOW.toISOString(), reason: null });
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(await noteMetaAccountStatus(T, "act_1", 2, later, m.deps)).toBe("blocked");
    expect(await readAccountMarker(T, META_ACCOUNT_BLOCKED_MARKER, m.deps)).toEqual({ since: later.toISOString(), reason: "disabled" });
    expect(m.alert).toHaveBeenCalledTimes(2);
  });

  it("clears the marker when it comes back, without an alert", async () => {
    const m = markers({ [`${META_ACCOUNT_BLOCKED_MARKER}:unsettled`]: NOW.getTime() - 86_400_000 });
    expect(await noteMetaAccountStatus(T, "act_1", 1, NOW, m.deps)).toBe("ready");
    expect(m.store.size).toBe(0);
    expect(await noteMetaAccountStatus(T, "act_1", 1, NOW, m.deps)).toBe("unchanged");
    expect(m.alert).not.toHaveBeenCalled();
  });

  it("a read that carried no status changes nothing", async () => {
    const m = markers({ [`${META_ACCOUNT_BLOCKED_MARKER}:disabled`]: 1 });
    expect(await noteMetaAccountStatus(T, "act_1", undefined, NOW, m.deps)).toBe("unchanged");
    expect(m.alert).not.toHaveBeenCalled();
  });
});

describe("noteMetaReadiness", () => {
  it("keeps the reason so the words stay right, and clears it once Meta can take ads", async () => {
    const m = markers();
    expect(await noteMetaReadiness(T, "page_permission_missing", NOW, m.deps)).toBe("blocked");
    expect(await readAccountMarker(T, META_NOT_READY_MARKER, m.deps)).toEqual({ since: NOW.toISOString(), reason: "page_permission_missing" });
    expect(await noteMetaReadiness(T, null, new Date(NOW.getTime() + 7_200_000), m.deps)).toBe("ready");
    expect(await readAccountMarker(T, META_NOT_READY_MARKER, m.deps)).toBeNull();
  });

  it("a failed check is not a finding: it neither opens nor closes anything", async () => {
    const m = markers();
    expect(await noteMetaReadiness(T, "lookup_failed", NOW, m.deps)).toBe("unchanged");
    expect(await noteMetaReadiness(T, "meta_busy", NOW, m.deps)).toBe("unchanged");
    expect(await noteMetaReadiness(T, "token_expired", NOW, m.deps)).toBe("unchanged");
    expect(m.alert).not.toHaveBeenCalled();
  });
});

describe("noteGoogleAccountStatus", () => {
  it("a suspended, cancelled or closed Google account is blocked once per spell, and ready again when enabled", async () => {
    expect(googleAccountStatusWord("SUSPENDED")).toBe("suspended");
    expect(googleAccountStatusWord("ENABLED")).toBeNull();
    const m = markers();
    expect(await noteGoogleAccountStatus(T, "123", "SUSPENDED", NOW, m.deps)).toBe("blocked");
    expect(await noteGoogleAccountStatus(T, "123", "SUSPENDED", new Date(NOW.getTime() + 3_600_000), m.deps)).toBe("unchanged");
    expect(m.store.get(`${GOOGLE_ACCOUNT_BLOCKED_MARKER}:suspended`)).toBe(NOW.getTime());
    expect(m.alert).toHaveBeenCalledTimes(1);
    expect(await noteGoogleAccountStatus(T, "123", "ENABLED", NOW, m.deps)).toBe("ready");
    expect(m.store.size).toBe(0);
  });

  it("a status Google did not say, or could not name, changes nothing", async () => {
    const m = markers({ [`${GOOGLE_ACCOUNT_BLOCKED_MARKER}:suspended`]: NOW.getTime() });
    for (const s of [null, undefined, "", "UNKNOWN", "UNSPECIFIED"]) expect(await noteGoogleAccountStatus(T, "123", s, NOW, m.deps)).toBe("unchanged");
    expect(m.alert).not.toHaveBeenCalled();
  });
});
