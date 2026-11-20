import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/sandbox/lifecycle", () => ({
  getSandboxIdForRun: vi.fn(async () => "sandbox-abc"),
}));
vi.mock("../daemon-client", () => ({
  callDaemon: vi.fn(async () => ({ ok: true, result: "daemon" })),
}));
vi.mock("../social-connections", () => ({
  tenantHasConnectedProfileForOrigin: vi.fn(async () => false),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

const flag = { on: true };
vi.mock("@/services/extension/control-flag", () => ({
  isExtensionBrowserControlEnabled: vi.fn(async () => flag.on),
}));

type Sent = { op: Record<string, unknown>; is_write: boolean; seq: number; session: string; user: string };
const panel = {
  url: "https://adsmanager.facebook.com/adsmanager/manage",
  sent: [] as Sent[],
  clickGoesTo: null as string | null,
  nextStatus: "done" as "done" | "failed" | "unknown" | "expired",
  enqueueRefusal: null as null | "no_panel" | "tab_mismatch",
  resolve: {} as Record<string, unknown>,
  held: new Map<string, { op: Record<string, unknown>; status: string }>(),
};
const results = new Map<string, { status: string; result?: unknown }>();

function perform(id: string, op: Record<string, unknown>) {
  if (op.op === "nav") panel.url = op.url as string;
  if (op.op === "click_ref" && panel.clickGoesTo) panel.url = panel.clickGoesTo;
  const extra =
    op.op === "resolve"
      ? { ref: op.ref ?? { frame_session: null, backend_node_id: 1 }, ...panel.resolve }
      : op.op === "screenshot"
        ? { image_base64: "aW1n" }
        : {};
  results.set(id, {
    status: panel.nextStatus,
    result: { top_url: panel.url, ...extra, error_code: panel.nextStatus === "failed" ? "cdp_error" : undefined },
  });
}

vi.mock("@/services/extension/browser-ops", () => ({
  enqueueOp: vi.fn(async (input: Record<string, unknown>) => {
    if (panel.enqueueRefusal) return { ok: false, reason: panel.enqueueRefusal };
    const op = input.op as Record<string, unknown>;
    if (input.status === "awaiting_confirm") {
      const id = `held-${panel.held.size + 1}`;
      panel.held.set(id, { op, status: "awaiting_confirm" });
      return { ok: true, op_id: id };
    }
    panel.sent.push({
      op,
      is_write: input.is_write as boolean,
      seq: input.seq as number,
      session: input.session_id as string,
      user: input.user_id as string,
    });
    const id = `op-${panel.sent.length}`;
    const isProbe = op.op === "assert_url" && op.expected === "";
    const isLook = op.op === "resolve" || op.op === "screenshot";
    if (!isProbe && !isLook && panel.nextStatus !== "done" && panel.nextStatus !== "failed") {
      results.set(id, { status: panel.nextStatus });
      return { ok: true, op_id: id };
    }
    if (isProbe || isLook) {
      const saved = panel.nextStatus;
      panel.nextStatus = "done";
      perform(id, op);
      panel.nextStatus = saved;
    } else {
      perform(id, op);
    }
    return { ok: true, op_id: id };
  }),
  awaitOpResult: vi.fn(async (a: { op_id: string }) => results.get(a.op_id) ?? { status: "not_found" }),
  releaseHeldOp: vi.fn(async (a: { op_id: string }) => {
    const h = panel.held.get(a.op_id);
    if (!h || h.status !== "awaiting_confirm") return false;
    h.status = "queued";
    panel.sent.push({ op: h.op, is_write: true, seq: 0, session: "sess-1", user: "user-a" });
    perform(a.op_id, h.op);
    return true;
  }),
  expireHeldOp: vi.fn(async (_t: string, id: string) => {
    const h = panel.held.get(id);
    if (h && h.status === "awaiting_confirm") h.status = "expired";
  }),
  readOpStatus: vi.fn(async (_t: string, id: string) => panel.held.get(id)?.status ?? null),
  isSessionLive: vi.fn(async () => true),
}));

import { runBrowserOp, _resetRunEngineCache, MAX_EXTENSION_WRITES_PER_RUN } from "../backend";
import { _setMoneyGateDeps, type DecisionState } from "../extension-money-gate";
import { _pinnedSite } from "../extension-backend";
import { classifyBrowserOp } from "../browser-action-gate";
import { pinnedEngine } from "../engine-policy";
import { _setBrowserActionEmitter, type BrowserActionDecisionEmitter } from "../anchor-backend";
import { callDaemon } from "../daemon-client";
import type { BrowserToolCtx, DaemonOp } from "../types";

const REF = { frame_session: null, backend_node_id: 42 };
const CLICK: DaemonOp = { op: "click_ref", ref: REF };

function extCtx(run_id: string, over: Partial<BrowserToolCtx> = {}): BrowserToolCtx {
  return {
    tenant_id: "t1",
    run_id,
    agent_slug: "operator",
    repo_full_name: "",
    user_id: "user-a",
    extension: { panel_session_id: "sess-1", tab_id: 9 },
    ...over,
  };
}

const emitted: { decision_class: string; body: Record<string, unknown> }[] = [];
let decisionState: DecisionState | null = null;
let decisionAnswer: Partial<DecisionState> | null = null;
const emitter: BrowserActionDecisionEmitter = {
  emit: vi.fn(async (a) => {
    emitted.push(a);
    decisionState = { status: "proposed", approved_by: null, body: a.body };
    return "dec-1";
  }),
};

beforeEach(() => {
  _resetRunEngineCache();
  flag.on = true;
  panel.url = "https://adsmanager.facebook.com/adsmanager/manage";
  panel.sent = [];
  panel.clickGoesTo = null;
  panel.nextStatus = "done";
  panel.enqueueRefusal = null;
  results.clear();
  panel.resolve = {};
  panel.held.clear();
  emitted.length = 0;
  decisionState = null;
  decisionAnswer = null;
  _setMoneyGateDeps({
    readDecision: async () => {
      if (decisionState && decisionAnswer) decisionState = { ...decisionState, ...decisionAnswer };
      return decisionState;
    },
    expireDecision: async () => {
      if (decisionState?.status === "proposed") decisionState = { ...decisionState, status: "expired" };
    },
    sleep: async () => undefined,
  });
  _setBrowserActionEmitter(emitter);
  vi.mocked(callDaemon).mockClear();
});

const realOps = () =>
  panel.sent.filter(
    (s) => !(s.op.op === "assert_url" && s.op.expected === "") && s.op.op !== "resolve" && s.op.op !== "screenshot",
  );

describe("engine selection", () => {
  it("pins only a ctx that carries a panel session", () => {
    expect(pinnedEngine(extCtx("r"))).toBe("extension");
    expect(pinnedEngine({ extension: undefined })).toBeNull();
  });

  it("routes an extension-surface run to the panel, never to the sandbox daemon", async () => {
    const r = await runBrowserOp(extCtx("r1"), { op: "ax_snapshot" });
    expect(r.ok).toBe(true);
    expect(realOps().map((s) => s.op.op)).toEqual(["ax_snapshot"]);
    expect(panel.sent.every((s) => s.session === "sess-1" && s.user === "user-a")).toBe(true);
    expect(callDaemon).not.toHaveBeenCalled();
  });

  it("leaves every other run on origin routing (a plain ctx never reaches the panel)", async () => {
    const r = await runBrowserOp(
      { tenant_id: "t1", run_id: "r2", agent_slug: "qa", repo_full_name: "x/y" },
      { op: "nav", url: "https://staging.example.com/app" },
    );
    expect(r).toEqual({ ok: true, result: "daemon" });
    expect(panel.sent).toHaveLength(0);
  });

  it("a run pinned to the extension that later loses its panel fields fails closed, not to a cloud browser", async () => {
    await runBrowserOp(extCtx("r3"), { op: "ax_snapshot" });
    const r = await runBrowserOp(
      { tenant_id: "t1", run_id: "r3", agent_slug: "operator", repo_full_name: "" },
      { op: "nav", url: "https://www.facebook.com/" },
    );
    expect(r).toMatchObject({ ok: false, error_code: "no_panel" });
    expect(callDaemon).not.toHaveBeenCalled();
  });
});

describe("op classification", () => {
  it.each([
    ["ax_snapshot", "read"],
    ["scroll", "read"],
    ["screenshot", "read"],
    ["assert_url", "read"],
    ["nav", "read"],
    ["click_ref", "write"],
    ["type_ref", "write"],
    ["select_option", "write"],
    ["set_checked", "write"],
    ["key", "write"],
    ["hover_ref", "read"],
    ["hover_xy", "read"],
    ["scroll_at", "read"],
    ["zoom", "read"],
    ["get_page_text", "read"],
    ["wait_until", "read"],
    ["nav_history", "read"],
    ["history_go", "read"],
    ["click_xy", "write"],
    ["drag_ref", "write"],
    ["drag_xy", "write"],
    ["key_chord", "write"],
    ["choose", "write"],
    ["reload", "write"],
  ])("%s is a %s", (op, cls) => {
    expect(classifyBrowserOp({ op })).toBe(cls);
  });

  it("marks writes as writes on the wire (so a lost one is never re-sent)", async () => {
    await runBrowserOp(extCtx("r4"), CLICK);
    const click = panel.sent.find((s) => s.op.op === "click_ref")!;
    expect(click.is_write).toBe(true);
    expect(panel.sent.find((s) => s.op.op === "assert_url")!.is_write).toBe(false);
  });
});

describe("autonomy flag + bound actor", () => {
  it("flag OFF: a click is NOT run and no approval card is proposed (no replay path exists)", async () => {
    flag.on = false;
    const r = await runBrowserOp(extCtx("r5"), CLICK);
    expect(r).toMatchObject({ ok: false, error_code: "browser_write_extension_disabled" });
    expect(realOps()).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it.each([
    { op: "click_xy", x: 1, y: 1, shot_w: 10, shot_h: 10 },
    { op: "drag_ref", ref: { frame_session: null, backend_node_id: 1 }, to_ref: { frame_session: null, backend_node_id: 2 } },
    { op: "drag_xy", x: 1, y: 1, to_x: 2, to_y: 2, shot_w: 10, shot_h: 10 },
    { op: "key_chord", key: "v", modifiers: ["Mod"] },
    { op: "choose", ref: { frame_session: null, backend_node_id: 1 }, option: "Lifetime" },
    { op: "reload", expect_url: "https://adsmanager.facebook.com/x" },
  ] as DaemonOp[])("flag OFF: $op is NOT run", async (op) => {
    flag.on = false;
    const r = await runBrowserOp(extCtx(`r5-${op.op}`), op);
    expect(r).toMatchObject({ ok: false, error_code: "browser_write_extension_disabled" });
    expect(realOps()).toHaveLength(0);
  });

  it.each([
    { op: "hover_ref", ref: { frame_session: null, backend_node_id: 1 } },
    { op: "hover_xy", x: 1, y: 1, shot_w: 10, shot_h: 10 },
  ] as DaemonOp[])("flag OFF: $op is NOT run", async (op) => {
    flag.on = false;
    const r = await runBrowserOp(extCtx(`r5h-${op.op}`), op);
    expect(r).toMatchObject({ ok: false, error_code: "browser_write_extension_disabled" });
    expect(realOps()).toHaveLength(0);
  });

  it("flag OFF: reads still run", async () => {
    flag.on = false;
    expect((await runBrowserOp(extCtx("r6"), { op: "scroll", dy: 400 })).ok).toBe(true);
    expect(realOps().map((s) => s.op.op)).toEqual(["scroll"]);
  });

  it("flag OFF: a nav to a one-click action link is refused", async () => {
    flag.on = false;
    const r = await runBrowserOp(extCtx("r6b"), {
      op: "nav",
      url: "https://www.facebook.com/billing/pay?confirm=1",
    });
    expect(r).toMatchObject({ ok: false, error_code: "browser_nav_side_effect_blocked" });
    expect(realOps()).toHaveLength(0);
  });

  it("flag ON with a bound actor + panel: the click runs inline", async () => {
    const r = await runBrowserOp(extCtx("r7"), CLICK);
    expect(r.ok).toBe(true);
    expect(realOps().map((s) => s.op.op)).toEqual(["click_ref"]);
    expect(emitted).toHaveLength(0);
  });

  it("flag ON but NO bound actor: the click does not run", async () => {
    const r = await runBrowserOp(extCtx("r8", { user_id: undefined }), CLICK);
    expect(r).toMatchObject({ ok: false, error_code: "no_panel" });
    expect(panel.sent).toHaveLength(0);
  });
});

describe("write cap", () => {
  it(`is ${MAX_EXTENSION_WRITES_PER_RUN} per task on this engine`, async () => {
    expect(MAX_EXTENSION_WRITES_PER_RUN).toBe(60);
    const c = extCtx("r9");
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await runBrowserOp(c, { op: "key", key: "Tab" })).ok).toBe(true);
    }
    const r = await runBrowserOp(c, { op: "key", key: "Tab" });
    expect(r).toMatchObject({ ok: false, error_code: "browser_write_cap_exceeded" });
    expect(realOps()).toHaveLength(60);
    expect((await runBrowserOp(c, { op: "ax_snapshot" })).ok).toBe(true);
  });
});

describe("outcome mapping", () => {
  it("a lost write comes back as extension_op_unknown and is sent once", async () => {
    panel.nextStatus = "unknown";
    const r = await runBrowserOp(extCtx("r10"), CLICK);
    expect(r).toMatchObject({ ok: false, error_code: "extension_op_unknown" });
    expect(realOps()).toHaveLength(1);
  });

  it("an op the panel never picked up is extension_op_expired", async () => {
    panel.nextStatus = "expired";
    expect(await runBrowserOp(extCtx("r11"), { op: "ax_snapshot" })).toMatchObject({
      ok: false,
      error_code: "extension_op_expired",
    });
  });

  it("a panel failure carries the panel's code", async () => {
    panel.nextStatus = "failed";
    expect(await runBrowserOp(extCtx("r12"), { op: "ax_snapshot" })).toMatchObject({
      ok: false,
      error_code: "cdp_error",
    });
  });

  it("a dead panel session is no_panel", async () => {
    panel.enqueueRefusal = "no_panel";
    expect(await runBrowserOp(extCtx("r13"), { op: "ax_snapshot" })).toMatchObject({
      ok: false,
      error_code: "no_panel",
    });
  });
});

describe("origin lock", () => {
  it("pins the registrable site of the tab at task start (subdomains of it stay in)", async () => {
    const c = extCtx("o1");
    await runBrowserOp(c, { op: "ax_snapshot" });
    expect(_pinnedSite("o1")).toBe("facebook.com");
    const r = await runBrowserOp(c, { op: "nav", url: "https://business.facebook.com/settings" });
    expect(r.ok).toBe(true);
    expect((await runBrowserOp(c, CLICK)).ok).toBe(true);
  });

  it("a one-click action nav (unsubscribe) is treated as a write by the kill switch", async () => {
    const c = extCtx("ks-nav");
    await runBrowserOp(c, { op: "ax_snapshot" });
    const { isExtensionBrowserControlEnabled } = await import("@/services/extension/control-flag");
    let reads = 0;
    vi.mocked(isExtensionBrowserControlEnabled).mockImplementation(async () => {
      reads += 1;
      return reads <= 1;
    });
    try {
      const before = realOps().length;
      const r = await runBrowserOp(c, { op: "nav", url: "https://www.facebook.com/email/unsubscribe?id=1" });
      expect(r).toMatchObject({ ok: false, error_code: "browser_write_extension_disabled" });
      expect(realOps().slice(before).some((o) => o.op.op === "nav")).toBe(false);
    } finally {
      vi.mocked(isExtensionBrowserControlEnabled).mockImplementation(async () => flag.on);
    }
  });

  it("refuses a nav to another site before sending it, then refuses every later op", async () => {
    const c = extCtx("o2");
    await runBrowserOp(c, { op: "ax_snapshot" });
    const r = await runBrowserOp(c, { op: "nav", url: "https://evil.example/phish" });
    expect(r).toMatchObject({ ok: false, error_code: "off_site" });
    expect(realOps().some((s) => s.op.op === "nav")).toBe(false);
    const after = panel.sent.length;
    expect(await runBrowserOp(c, { op: "ax_snapshot" })).toMatchObject({ error_code: "off_site" });
    expect(panel.sent.length).toBe(after);
  });

  it("refuses back / forward to another site before sending it", async () => {
    const c = extCtx("o2b");
    await runBrowserOp(c, { op: "ax_snapshot" });
    const r = await runBrowserOp(c, { op: "history_go", entry_id: 3, url: "https://evil.example/" });
    expect(r).toMatchObject({ ok: false, error_code: "off_site" });
    expect(realOps().some((s) => s.op.op === "history_go")).toBe(false);
  });

  it("a click that navigates off-site ends the task, and the next write is never sent", async () => {
    const c = extCtx("o3");
    panel.clickGoesTo = "https://attacker.example/";
    expect(await runBrowserOp(c, CLICK)).toMatchObject({ ok: false, error_code: "off_site" });
    panel.clickGoesTo = null;
    const before = realOps().length;
    expect(await runBrowserOp(c, { op: "type_ref", ref: REF, text: "x" })).toMatchObject({
      error_code: "off_site",
    });
    expect(realOps().length).toBe(before);
  });

  it("probes where the tab is before every write, so a drift since the last op is caught first", async () => {
    const c = extCtx("o4");
    await runBrowserOp(c, { op: "ax_snapshot" });
    panel.url = "https://checkout.stripe.com/pay/cs_1";
    expect(await runBrowserOp(c, CLICK)).toMatchObject({ ok: false, error_code: "off_site" });
    expect(realOps().some((s) => s.op.op === "click_ref")).toBe(false);
  });

  it("co.uk: shop.example.co.uk and www.example.co.uk are one site; other.co.uk is not", async () => {
    panel.url = "https://shop.example.co.uk/basket";
    const c = extCtx("o5");
    await runBrowserOp(c, { op: "ax_snapshot" });
    expect(_pinnedSite("o5")).toBe("example.co.uk");
    expect((await runBrowserOp(c, { op: "nav", url: "https://www.example.co.uk/" })).ok).toBe(true);
    expect(await runBrowserOp(c, { op: "nav", url: "https://other.co.uk/" })).toMatchObject({
      error_code: "off_site",
    });
  });

  it("a task started on a new-tab page pins the site of its first nav", async () => {
    panel.url = "chrome://newtab/";
    const c = extCtx("o6");
    expect((await runBrowserOp(c, { op: "nav", url: "https://ads.google.com/aw/overview" })).ok).toBe(true);
    expect(_pinnedSite("o6")).toBe("google.com");
  });

  it("will not write on a page with no site", async () => {
    panel.url = "about:blank";
    const r = await runBrowserOp(extCtx("o7"), CLICK);
    expect(r).toMatchObject({ ok: false, error_code: "site_unknown" });
    expect(realOps()).toHaveLength(0);
  });

  it("refuses a non-http(s) nav", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings"]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await runBrowserOp(extCtx(`o8-${url}`), { op: "nav", url })).toMatchObject({
        error_code: "nav_blocked",
      });
    }
    expect(panel.sent).toHaveLength(0);
  });
});

describe("S3 money-step pause, end to end through runBrowserOp", () => {
  const PUBLISH = { role: "button", name: "Publish", ref: REF };

  it("a Publish on Ads Manager files ONE extension.money_step card and waits; the owner's confirm runs the held click once", async () => {
    panel.resolve = PUBLISH;
    decisionAnswer = { status: "approved", approved_by: "user-a" };
    const r = await runBrowserOp(extCtx("m1"), CLICK);
    expect(r.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].decision_class).toBe("extension.money_step");
    expect(emitted[0].body).toMatchObject({ host: "adsmanager.facebook.com", label: "Publish", run_owner_user_id: "user-a" });
    const held = [...panel.held.values()];
    expect(held).toHaveLength(1);
    expect(held[0].status).toBe("queued");
    expect(realOps().filter((s) => s.op.op === "click_ref")).toHaveLength(1);
  });

  it("the kill switch turned off while the card waited: the confirmed click does not run", async () => {
    panel.resolve = PUBLISH;
    decisionAnswer = { status: "approved", approved_by: "user-a" };
    _setMoneyGateDeps({
      readDecision: async () => {
        flag.on = false;
        if (decisionState && decisionAnswer) decisionState = { ...decisionState, ...decisionAnswer };
        return decisionState;
      },
      expireDecision: async () => undefined,
      sleep: async () => undefined,
    });
    const r = await runBrowserOp(extCtx("ks1"), CLICK);
    expect(r).toMatchObject({ ok: false, error_code: "browser_write_extension_disabled" });
    expect(realOps().filter((s) => s.op.op === "click_ref")).toHaveLength(0);
    expect([...panel.held.values()].every((h) => h.status !== "queued")).toBe(true);
  });

  it("the kill switch turned off during the pre-release site check: the confirmed click does not run", async () => {
    panel.resolve = PUBLISH;
    decisionAnswer = { status: "approved", approved_by: "user-a" };
    const { isExtensionBrowserControlEnabled } = await import("@/services/extension/control-flag");
    let reads = 0;
    vi.mocked(isExtensionBrowserControlEnabled).mockImplementation(async () => {
      reads += 1;
      return reads <= 2;
    });
    try {
      const r = await runBrowserOp(extCtx("ks2"), CLICK);
      expect(r).toMatchObject({ ok: false, error_code: "browser_write_extension_disabled" });
      expect(realOps().filter((s) => s.op.op === "click_ref")).toHaveLength(0);
    } finally {
      vi.mocked(isExtensionBrowserControlEnabled).mockImplementation(async () => flag.on);
    }
  });

  it("the kill switch turned off during the money-check resolve: an ordinary click does not run", async () => {
    panel.resolve = { ...PUBLISH, name: "Save draft", top_url: "https://mail.google.com/", frame_url: "https://mail.google.com/" };
    panel.url = "https://mail.google.com/";
    const { isExtensionBrowserControlEnabled } = await import("@/services/extension/control-flag");
    let reads = 0;
    vi.mocked(isExtensionBrowserControlEnabled).mockImplementation(async () => (reads += 1) <= 1);
    try {
      const r = await runBrowserOp(extCtx("ks3"), CLICK);
      expect(r).toMatchObject({ ok: false, error_code: "browser_write_extension_disabled" });
      expect(panel.sent.filter((s) => s.op.op === "resolve")).toHaveLength(1);
      expect(realOps().filter((s) => s.op.op === "click_ref")).toHaveLength(0);
    } finally {
      vi.mocked(isExtensionBrowserControlEnabled).mockImplementation(async () => flag.on);
    }
  });

  it("no confirm: the click never runs and the model reads the approved copy", async () => {
    panel.resolve = PUBLISH;
    decisionAnswer = { status: "rejected" };
    const r = await runBrowserOp(extCtx("m2"), CLICK);
    expect(r).toEqual({ ok: false, error_code: "money_step_not_confirmed", error_message: "I didn't get a confirm, so I skipped that step." });
    expect([...panel.held.values()][0].status).toBe("expired");
  });

  it("the page changed between the card and the confirm: stale, the click never runs", async () => {
    panel.resolve = PUBLISH;
    decisionAnswer = { status: "approved", approved_by: "user-a" };
    const d = await import("../extension-money-gate");
    let n = 0;
    d._setMoneyGateDeps({
      readDecision: async () => {
        n += 1;
        if (n > 1) panel.resolve = { ...PUBLISH, name: "Publish and boost" };
        if (decisionState && decisionAnswer && n > 1) decisionState = { ...decisionState, ...decisionAnswer };
        return decisionState;
      },
      sleep: async () => undefined,
    });
    const r = await runBrowserOp(extCtx("m3"), CLICK);
    expect(r).toMatchObject({ ok: false, error_code: "stale" });
    expect([...panel.held.values()][0].status).toBe("expired");
  });

  it("an ordinary click does not pause", async () => {
    panel.resolve = { role: "button", name: "Next", ref: REF };
    expect((await runBrowserOp(extCtx("m4"), CLICK)).ok).toBe(true);
    expect(emitted).toHaveLength(0);
    expect(panel.held.size).toBe(0);
  });

  it("flag ON: a nav to a pay link pauses; flag OFF it is refused outright", async () => {
    decisionAnswer = { status: "rejected" };
    const r = await runBrowserOp(extCtx("m5"), { op: "nav", url: "https://www.facebook.com/billing/pay/1" });
    expect(r).toMatchObject({ error_code: "money_step_not_confirmed" });
    expect(realOps().some((s) => s.op.op === "nav")).toBe(false);
    expect(emitted[0].body).toMatchObject({ op: "nav", reason: "nav_money_url" });
  });

  it("a nav to a delete link is not a money step (D14) and runs", async () => {
    const r = await runBrowserOp(extCtx("m6"), { op: "nav", url: "https://www.facebook.com/delete/1" });
    expect(r.ok).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});

describe("S3: a money nav off the pinned site", () => {
  it("is refused by the origin lock without asking the founder", async () => {
    const c = extCtx("m7");
    await runBrowserOp(c, { op: "ax_snapshot" });
    const r = await runBrowserOp(c, { op: "nav", url: "https://evil.example/checkout" });
    expect(r).toMatchObject({ ok: false, error_code: "off_site" });
    expect(emitted).toHaveLength(0);
  });
});
