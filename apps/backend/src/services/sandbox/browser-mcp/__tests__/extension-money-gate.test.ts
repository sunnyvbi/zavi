import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runWithMoneyGate,
  _resetMoneyGateState,
  MONEY_CONFIRM_WAIT_MS,
  MONEY_STEP_DECISION_CLASS,
  NOT_CONFIRMED_COPY,
  type MoneyGateDeps,
  type DecisionState,
} from "../extension-money-gate";
import { moneyCardSealIntact } from "@/services/approvals/money-card";
import type { BrowserToolCtx, DaemonOp, DaemonResult } from "../types";

const REF = { frame_session: null, backend_node_id: 7 };
const CLICK: DaemonOp = { op: "click_ref", ref: REF };
const ctx: BrowserToolCtx = {
  tenant_id: "t1",
  run_id: "run-1",
  agent_slug: "operator",
  repo_full_name: "",
  user_id: "member-1",
  extension: { panel_session_id: "s1", tab_id: 3 },
};

const PUBLISH = {
  top_url: "https://adsmanager.facebook.com/adsmanager/manage",
  frame_url: "https://adsmanager.facebook.com/adsmanager/manage",
  role: "button",
  name: "Publish",
  hints: "",
  is_submit: false,
  ref: REF,
  form: { has_card_field: false, budget_fields: [] },
  page_has_payment_frame: false,
};

let resolves: unknown[];
let resolveOk: boolean;
let shotOk: boolean;
let decision: DecisionState | null;
let decisionAfter: ((n: number) => DecisionState | null) | null;
let reads: number;
let held: string | null;
let live: boolean;
let t: number;
const calls: string[] = [];
let emitted: Record<string, unknown> | null;
let emitThrows: boolean;
let emitReturnsOther: boolean;

function deps(): MoneyGateDeps {
  return {
    read: vi.fn(async (_c, op: DaemonOp): Promise<DaemonResult> => {
      calls.push(`read:${op.op}`);
      if (op.op === "resolve") {
        if (!resolveOk) return { ok: false, error_code: "cdp_error", error_message: "x" };
        const r = resolves.length > 1 ? resolves.shift() : resolves[0];
        return { ok: true, result: r };
      }
      return shotOk ? { ok: true, result: { image_base64: `img-${t}` } } : { ok: false, error_code: "no_image", error_message: "x" };
    }),
    run: vi.fn(async (_c, op: DaemonOp) => {
      calls.push(`run:${op.op}`);
      return { ok: true as const, result: {} };
    }),
    hold: vi.fn(async () => {
      calls.push("hold");
      held = "awaiting_confirm";
      return { ok: true as const, op_id: "op-held" };
    }),
    runHeld: vi.fn(async (_c, op: DaemonOp, id: string) => {
      calls.push(`runHeld:${op.op}:${id}`);
      return { ok: true as const, result: {} };
    }),
    dropHeld: vi.fn(async () => {
      calls.push("drop");
      held = "expired";
    }),
    heldStatus: vi.fn(async () => held),
    emit: vi.fn(async (a) => {
      calls.push("emit");
      if (emitThrows) throw new Error("emit_decision failed");
      emitted = a.body;
      decision = { status: "proposed", approved_by: null, body: emitReturnsOther ? { held_op_id: "someone-elses" } : a.body };
      return "dec-1";
    }),
    readDecision: vi.fn(async () => {
      reads += 1;
      if (decisionAfter && reads > 1) {
        const d = decisionAfter(reads);
        if (d) decision = d;
      }
      return decision;
    }),
    expireDecision: vi.fn(async () => {
      calls.push("expire");
      if (decision?.status === "proposed") decision = { ...decision, status: "expired" };
    }),
    sessionLive: vi.fn(async () => live),
    logUnsure: vi.fn(async () => {
      calls.push("unsure");
    }),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const approvedBy = (user: string) => () => ({ status: "approved", approved_by: user, body: emitted });

beforeEach(() => {
  _resetMoneyGateState();
  resolves = [PUBLISH];
  resolveOk = true;
  shotOk = true;
  decision = null;
  decisionAfter = null;
  reads = 0;
  held = null;
  live = true;
  t = 1_000_000;
  calls.length = 0;
  emitted = null;
  emitThrows = false;
  emitReturnsOther = false;
});

const ran = () => calls.some((c) => c.startsWith("run:") || c.startsWith("runHeld:"));

describe("not a money step: runs as before", () => {
  it("a Save draft click runs with no card", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://mail.google.com/", name: "Save draft" }];
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["read:resolve", "run:click_ref"]);
  });

  it("Tab / Escape / scroll never look", async () => {
    await runWithMoneyGate(ctx, { op: "key", key: "Tab" }, deps());
    await runWithMoneyGate(ctx, { op: "scroll", dy: 100 }, deps());
    expect(calls).toEqual(["run:key", "run:scroll"]);
  });

  it("an unsure bare Confirm on a billing URL goes ahead and is logged (D5)", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://app.example.com/billing", name: "Confirm" }];
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["read:resolve", "unsure", "run:click_ref"]);
  });
});

describe("the detector cannot be skipped", () => {
  it("a failed resolve does NOT run the step", async () => {
    resolveOk = false;
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "money_check_failed" });
    expect(ran()).toBe(false);
  });

  it("a resolve that reports a different node does NOT run the step", async () => {
    resolves = [{ ...PUBLISH, name: "Save draft", ref: { frame_session: null, backend_node_id: 99 } }];
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "money_check_failed" });
    expect(ran()).toBe(false);
  });

  it("Enter resolves the focused element (ref null)", async () => {
    const d = deps();
    resolves = [{ ...PUBLISH, top_url: "https://www.google.com/", name: "Search", role: "searchbox" }];
    await runWithMoneyGate(ctx, { op: "key", key: "Enter" }, d);
    expect(d.read).toHaveBeenCalledWith(ctx, { op: "resolve", ref: null });
  });

  it("a nav to a pay link pauses without a resolve", async () => {
    decisionAfter = approvedBy("member-1");
    const r = await runWithMoneyGate(ctx, { op: "nav", url: "https://app.example.com/billing/pay/inv_1" }, deps());
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c === "read:resolve")).toHaveLength(0);
    expect(emitted).toMatchObject({ op: "nav", host: "app.example.com", reason: "nav_money_url" });
    expect(emitted!.summary).toBe("On app.example.com I'm about to open the checkout page.");
  });
});

describe("money step: one sealed card, confirmed by the run owner", () => {
  it("files a sealed card and runs the HELD op only after the owner confirms", async () => {
    decisionAfter = approvedBy("member-1");
    const d = deps();
    const r = await runWithMoneyGate(ctx, CLICK, d);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      "read:resolve",
      "read:screenshot",
      "hold",
      "emit",
      "read:resolve",
      "read:screenshot",
      "runHeld:click_ref:op-held",
    ]);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ decision_class: MONEY_STEP_DECISION_CLASS, agent_run_id: "run-1", tenant_id: "t1" }));
    expect(emitted).toMatchObject({
      host: "adsmanager.facebook.com",
      label: "Publish",
      op: "click_ref",
      run_owner_user_id: "member-1",
      held_op_id: "op-held",
      backend_node_id: 7,
      frame_session: null,
      summary: 'On adsmanager.facebook.com I\'m about to click "Publish".',
    });
    expect(String(emitted!.screenshot_id)).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(moneyCardSealIntact(MONEY_STEP_DECISION_CLASS, emitted)).toBe(true);
    for (const v of Object.values(emitted!)) expect(typeof v === "object" && v !== null).toBe(false);
  });

  it("a budget typed on Google Ads carries the value line", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://ads.google.com/aw/campaigns", role: "textbox", name: "Average daily budget" }];
    decisionAfter = approvedBy("member-1");
    await runWithMoneyGate(ctx, { op: "type_ref", ref: REF, text: "$50.00" }, deps());
    expect(emitted).toMatchObject({ value: "$50.00", value_line: null });
    expect(emitted!.summary).toBe('On ads.google.com I\'m about to change "Average daily budget" to $50.00.');
  });

  it("emit failure: fail closed, the held op is dropped, nothing runs", async () => {
    emitThrows = true;
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "money_confirm_unavailable" });
    expect(calls).toContain("drop");
    expect(ran()).toBe(false);
  });

  it("emit handed back someone else's card (dedup / suppression): nothing runs", async () => {
    emitReturnsOther = true;
    decisionAfter = () => ({ status: "approved", approved_by: "member-1", body: { held_op_id: "someone-elses" } });
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "money_confirm_unavailable" });
    expect(ran()).toBe(false);
  });

  it("no screenshot: fail closed before any card", async () => {
    shotOk = false;
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "money_check_failed" });
    expect(calls).not.toContain("hold");
    expect(ran()).toBe(false);
  });

  it("rejected: the model reads the approved copy, nothing runs", async () => {
    decisionAfter = () => ({ status: "rejected", approved_by: null, body: emitted });
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toEqual({ ok: false, error_code: "money_step_not_confirmed", error_message: NOT_CONFIRMED_COPY });
    expect(NOT_CONFIRMED_COPY).toBe("I didn't get a confirm, so I skipped that step.");
    expect(calls).toContain("drop");
    expect(ran()).toBe(false);
  });

  it("no answer in 10 minutes: the card is expired, nothing runs", async () => {
    const start = t;
    const d = deps();
    const r = await runWithMoneyGate(ctx, CLICK, d);
    expect(r).toMatchObject({ error_code: "money_step_not_confirmed", error_message: NOT_CONFIRMED_COPY });
    expect(t - start).toBeGreaterThanOrEqual(MONEY_CONFIRM_WAIT_MS);
    expect(t - start).toBeLessThan(MONEY_CONFIRM_WAIT_MS + 5_000);
    expect(d.expireDecision).toHaveBeenCalledWith("t1", "dec-1");
    expect(ran()).toBe(false);
  });

  it("an approve by anyone but the run owner does NOT run it (even if it got past decide)", async () => {
    decisionAfter = approvedBy("owner-9");
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "money_confirm_refused" });
    expect(ran()).toBe(false);
  });

  it("consent revoke / Stop while waiting (held op expired): stops, nothing runs", async () => {
    decisionAfter = (n) => {
      if (n === 3) held = "expired";
      return null;
    };
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "extension_op_expired" });
    expect(calls).toContain("expire");
    expect(ran()).toBe(false);
  });

  it("the panel closed while waiting: stops, nothing runs", async () => {
    live = false;
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "no_panel" });
    expect(ran()).toBe(false);
  });
});

describe("after the confirm: the page must still be what was confirmed", () => {
  const changed: [string, unknown][] = [
    ["label changed", { ...PUBLISH, name: "Publish and boost $5,000" }],
    ["frame changed", { ...PUBLISH, frame_url: "https://evil.example/frame" }],
    ["role changed", { ...PUBLISH, role: "menuitem" }],
    ["card context appeared", { ...PUBLISH, form: { has_card_field: true, budget_fields: [] } }],
    ["budget value changed", { ...PUBLISH, form: { has_card_field: false, budget_fields: [{ label: "Budget", value: "$5000" }] } }],
    ["no longer a money step", { ...PUBLISH, top_url: "https://docs.google.com/document/d/1" }],
    ["a different node answered", { ...PUBLISH, ref: { frame_session: "F2", backend_node_id: 7 } }],
    ["the total on the page changed", { ...PUBLISH, amounts: ["$2,000.00"] }],
  ];
  it.each(changed)("%s → stale, nothing runs", async (_n, second) => {
    resolves = [PUBLISH, second];
    decisionAfter = approvedBy("member-1");
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "stale" });
    expect(calls).toContain("drop");
    expect(ran()).toBe(false);
  });

  it("a fresh resolve that fails after the confirm is stale, nothing runs", async () => {
    decisionAfter = (n) => {
      if (n === 2) resolveOk = false;
      return { status: "approved", approved_by: "member-1", body: emitted };
    };
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "stale" });
    expect(ran()).toBe(false);
  });

  it("a different screenshot alone is fine (it is a new capture by definition)", async () => {
    decisionAfter = approvedBy("member-1");
    const r = await runWithMoneyGate(ctx, CLICK, deps());
    expect(r.ok).toBe(true);
  });
});

describe("the card body never carries a frame URL's query string", () => {
  it("stores origin + path only", async () => {
    resolves = [{ ...PUBLISH, frame_url: "https://js.stripe.com/v3/elements?client_secret=pi_123_secret_abc#x" }];
    decisionAfter = () => ({ status: "rejected", approved_by: null, body: emitted });
    await runWithMoneyGate(ctx, CLICK, deps());
    expect(emitted!.frame_url).toBe("https://js.stripe.com/v3/elements");
    expect(JSON.stringify(emitted)).not.toContain("secret");
  });
});

describe("ask once per money change (Ravi 2026-09-30)", () => {
  const ADS = "https://ads.google.com/aw/campaigns";
  const TYPE = { ...PUBLISH, top_url: ADS, frame_url: ADS, role: "textbox", name: "Average daily budget", form: { kind: "dialog", scope_node_id: 40, has_card_field: false, budget_fields: [] } };
  const SAVE_REF = { frame_session: null, backend_node_id: 8 };
  const save = (over: Record<string, unknown> = {}, formOver: Record<string, unknown> = {}) => ({
    ...PUBLISH,
    top_url: ADS,
    frame_url: ADS,
    name: "Save",
    ref: SAVE_REF,
    form: { kind: "dialog", scope_node_id: 40, has_card_field: false, budget_fields: [{ label: "Average daily budget", value: "$50.00" }], ...formOver },
    ...over,
  });
  const TYPE_OP: DaemonOp = { op: "type_ref", ref: REF, text: "50" };
  const SAVE_OP: DaemonOp = { op: "click_ref", ref: SAVE_REF };
  const emits = () => calls.filter((c) => c === "emit").length;

  async function confirmBudgetThen(second: unknown, secondCtx: BrowserToolCtx = ctx, secondOp: DaemonOp = SAVE_OP) {
    resolves = [TYPE, TYPE, second];
    decisionAfter = approvedBy(secondCtx.user_id!);
    const d = deps();
    expect((await runWithMoneyGate(ctx, TYPE_OP, d)).ok).toBe(true);
    const r = await runWithMoneyGate(secondCtx, secondOp, d);
    return r;
  }

  it("(a) confirmed budget change + Save on the same form = ONE card", async () => {
    const r = await confirmBudgetThen(save());
    expect(r.ok).toBe(true);
    expect(emits()).toBe(1);
    expect(calls.at(-1)).toBe("run:click_ref");
  });

  it("(a) the typed '50' matches the page's '$50.00'; Publish on the same dialog also carries", async () => {
    const r = await confirmBudgetThen(save({ name: "Publish" }));
    expect(r.ok).toBe(true);
    expect(emits()).toBe(1);
  });

  it("(b) Save on a DIFFERENT form asks again", async () => {
    await confirmBudgetThen(save({}, { scope_node_id: 41 }));
    expect(emits()).toBe(2);
  });

  it("(b) Publish after the value changed on the page asks again", async () => {
    await confirmBudgetThen(save({ name: "Publish" }, { budget_fields: [{ label: "Average daily budget", value: "$500.00" }] }));
    expect(emits()).toBe(2);
  });

  it("(b) a different frame asks again", async () => {
    const F9 = { frame_session: "F9", backend_node_id: 8 };
    await confirmBudgetThen(save({ ref: F9 }), ctx, { op: "click_ref", ref: F9 });
    expect(emits()).toBe(2);
  });

  it("(b) another run asks again", async () => {
    await confirmBudgetThen(save(), { ...ctx, run_id: "run-2" });
    expect(emits()).toBe(2);
  });

  it("(b) a strong money word (Boost) on the same form asks again", async () => {
    await confirmBudgetThen(save({ name: "Boost" }));
    expect(emits()).toBe(2);
  });

  it("only the immediately-next money step: a second Save asks again", async () => {
    resolves = [TYPE, TYPE, save(), save()];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    await runWithMoneyGate(ctx, TYPE_OP, d);
    await runWithMoneyGate(ctx, SAVE_OP, d);
    await runWithMoneyGate(ctx, SAVE_OP, d);
    expect(emits()).toBe(2);
  });

  it("(b) repeated field labels (bulk editor) never carry", async () => {
    await confirmBudgetThen(
      save({}, { budget_fields: [{ label: "Average daily budget", value: "$50.00" }, { label: "Average daily budget", value: "$500.00" }] }),
    );
    expect(emits()).toBe(2);
  });

  it("(b) more budget fields than the panel reported never carry", async () => {
    await confirmBudgetThen(save({}, { budget_truncated: true }));
    expect(emits()).toBe(2);
  });

  it("a declined budget change carries nothing", async () => {
    resolves = [TYPE, save()];
    decisionAfter = () => ({ status: "rejected", approved_by: null, body: emitted });
    const d = deps();
    await runWithMoneyGate(ctx, TYPE_OP, d);
    decisionAfter = approvedBy("member-1");
    await runWithMoneyGate(ctx, SAVE_OP, d);
    expect(emits()).toBe(2);
  });
});

describe("S4: the tab task's clock pauses while the card waits", () => {
  it("reports the time the card was open to ctx.on_confirm_wait, once", async () => {
    const waited: number[] = [];
    const c = { ...ctx, on_confirm_wait: (ms: number) => waited.push(ms) };
    decisionAfter = (n) => (n >= 5 ? approvedBy("member-1")() : null);
    const r = await runWithMoneyGate(c, CLICK, deps());
    expect(r.ok).toBe(true);
    expect(waited).toHaveLength(1);
    expect(waited[0]).toBeGreaterThanOrEqual(3_000);
  });

  it("reports it on a timeout too, and a non-money step never reports", async () => {
    const waited: number[] = [];
    const c = { ...ctx, on_confirm_wait: (ms: number) => waited.push(ms) };
    const r = await runWithMoneyGate(c, CLICK, deps());
    expect(r).toMatchObject({ ok: false, error_code: "money_step_not_confirmed" });
    expect(waited).toEqual([expect.any(Number)]);
    expect(waited[0]).toBeGreaterThanOrEqual(MONEY_CONFIRM_WAIT_MS);
    resolves = [{ ...PUBLISH, top_url: "https://mail.google.com/", name: "Save draft" }];
    await runWithMoneyGate(c, CLICK, deps());
    expect(waited).toHaveLength(1);
  });
});

describe("H1 ops through the money pause", () => {
  const ADS = "https://adsmanager.facebook.com/adsmanager/manage";
  const BUDGET_SELECT = { ...PUBLISH, top_url: ADS, frame_url: ADS, role: "combobox", name: "Budget type", form: { kind: "form", scope_node_id: 40, has_card_field: false, budget_fields: [] } };

  it("select_option on an ad-host budget dropdown pauses like a typed budget, with the approved card shape", async () => {
    resolves = [BUDGET_SELECT];
    decisionAfter = approvedBy("member-1");
    const r = await runWithMoneyGate(ctx, { op: "select_option", ref: REF, label: "Lifetime" }, deps());
    expect(r.ok).toBe(true);
    expect(emitted).toMatchObject({ op: "select_option", reason: "ad_budget_field", value: "Lifetime", value_line: null });
    expect(emitted!.summary).toBe('On adsmanager.facebook.com I\'m about to change "Budget type" to Lifetime.');
    expect(calls.at(-1)).toBe("runHeld:select_option:op-held");
  });

  it("select_option on an ordinary dropdown runs with no card", async () => {
    resolves = [{ ...BUDGET_SELECT, top_url: "https://app.example.com/settings", frame_url: "https://app.example.com/settings", name: "Time zone" }];
    const r = await runWithMoneyGate(ctx, { op: "select_option", ref: REF, label: "UTC" }, deps());
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["read:resolve", "run:select_option"]);
  });

  it("set_checked is judged as the click it is: a checkbox on a checkout form is not money", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://shop.example.com/checkout", role: "checkbox", name: "Save my card for next time", form: { has_card_field: true, budget_fields: [] } }];
    const r = await runWithMoneyGate(ctx, { op: "set_checked", ref: REF, checked: true }, deps());
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c === "emit")).toHaveLength(0);
    expect(calls.at(-1)).toBe("run:set_checked");
  });

  it("Space on a focused Pay button pauses (Space activates a button like Enter)", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://shop.example.com/checkout", name: "Pay now", ref: REF }];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    await runWithMoneyGate(ctx, { op: "key", key: "Space" }, d);
    expect(d.read).toHaveBeenCalledWith(ctx, { op: "resolve", ref: null });
    expect(emitted).toMatchObject({ op: "key", reason: "money_label" });
  });

  it("Space in a text field of a card form is typing, not a submit", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://shop.example.com/checkout", role: "textbox", name: "Name on card", is_submit: true, form: { has_card_field: true, budget_fields: [] } }];
    const r = await runWithMoneyGate(ctx, { op: "key", key: "Space" }, deps());
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c === "emit")).toHaveLength(0);
  });

  it("an arrow key on an ad-host budget field is refused (no amount to confirm); elsewhere it runs", async () => {
    resolves = [{ ...BUDGET_SELECT, role: "spinbutton", name: "Daily budget" }];
    const r = await runWithMoneyGate(ctx, { op: "key", key: "ArrowUp" }, deps());
    expect(r).toMatchObject({ ok: false, error_code: "key_on_money_field" });
    expect(ran()).toBe(false);
    calls.length = 0;
    resolves = [{ ...PUBLISH, top_url: "https://app.example.com/", role: "listbox", name: "Fruits" }];
    expect((await runWithMoneyGate(ctx, { op: "key", key: "ArrowDown" }, deps())).ok).toBe(true);
    expect(calls).toEqual(["read:resolve", "run:key"]);
  });

  it("an arrow key on a focused Pay button is not a click: it runs", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://shop.example.com/checkout", name: "Pay now" }];
    const r = await runWithMoneyGate(ctx, { op: "key", key: "ArrowDown" }, deps());
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c === "emit")).toHaveLength(0);
  });

  it("a resolve that says the node left the page is handed back as no_node (the task re-finds it)", async () => {
    const d = deps();
    d.read = vi.fn(async () => ({ ok: false as const, error_code: "no_node", error_message: "gone" }));
    const r = await runWithMoneyGate(ctx, CLICK, d);
    expect(r).toMatchObject({ ok: false, error_code: "no_node" });
    expect(ran()).toBe(false);
  });

  it("ask once: a confirmed budget dropdown carries to the next Save on that form", async () => {
    const save = { ...PUBLISH, top_url: ADS, frame_url: ADS, name: "Save", ref: { frame_session: null, backend_node_id: 8 }, form: { kind: "form", scope_node_id: 40, has_card_field: false, budget_fields: [{ label: "Budget type", value: "Lifetime" }] } };
    resolves = [BUDGET_SELECT, BUDGET_SELECT, save];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    d.runHeld = vi.fn(async (_c, op: DaemonOp, id: string) => {
      calls.push(`runHeld:${op.op}:${id}`);
      return { ok: true as const, result: { value: "Lifetime" } };
    });
    expect((await runWithMoneyGate(ctx, { op: "select_option", ref: REF, value: "LIFETIME" }, d)).ok).toBe(true);
    expect((await runWithMoneyGate(ctx, { op: "click_ref", ref: { frame_session: null, backend_node_id: 8 } }, d)).ok).toBe(true);
    expect(calls.filter((c) => c === "emit")).toHaveLength(1);
  });
});

describe("a key is pinned to the focused element the check looked at (combined review F2)", () => {
  const FOCUSED = { frame_session: "f-2", backend_node_id: 44 };

  it("Enter that is not money runs with focus_ref = the resolved focused node", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://www.google.com/", name: "Search", role: "searchbox", ref: FOCUSED }];
    const d = deps();
    await runWithMoneyGate(ctx, { op: "key", key: "Enter" }, d);
    expect(d.run).toHaveBeenCalledWith(ctx, { op: "key", key: "Enter", focus_ref: FOCUSED });
  });

  it("a money Space is held pinned too (the held row is what the panel runs)", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://shop.example.com/checkout", name: "Pay now", ref: FOCUSED }];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    await runWithMoneyGate(ctx, { op: "key", key: "Space" }, d);
    expect(d.hold).toHaveBeenCalledWith(ctx, { op: "key", key: "Space", focus_ref: FOCUSED });
  });

  it("nothing focused → focus_ref null (the panel requires nothing focused)", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://www.google.com/", name: "", role: "", ref: null }];
    const d = deps();
    await runWithMoneyGate(ctx, { op: "key", key: "Enter" }, d);
    expect(d.run).toHaveBeenCalledWith(ctx, { op: "key", key: "Enter", focus_ref: null });
  });
});

describe("B1 write ops", () => {
  const PT = { x: 40, y: 30, shot_w: 500, shot_h: 400 };
  const HIT = (kind: string, extra: Record<string, unknown> = {}) => ({
    ...PUBLISH,
    hit_ref: { frame_session: null, backend_node_id: 70 },
    hit_kind: kind,
    ...extra,
  });
  const runOps = (d: MoneyGateDeps) =>
    [...(d.run as ReturnType<typeof vi.fn>).mock.calls, ...(d.runHeld as ReturnType<typeof vi.fn>).mock.calls].map((c) => c[1] as Record<string, unknown>);

  it("click_xy on a Publish button (span hit) pauses; resolve looked AT the point; the run is pinned to the hit node", async () => {
    resolves = [HIT("element")];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    const r = await runWithMoneyGate(ctx, { op: "click_xy", ...PT }, d);
    expect(r.ok).toBe(true);
    expect((d.read as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ op: "resolve", ref: null, at: PT });
    expect(emitted).toMatchObject({ op: "click_xy", label: "Publish", reason: "money_label_in_context" });
    expect(runOps(d)[0]).toMatchObject({ op: "click_xy", hit_ref: { frame_session: null, backend_node_id: 70 } });
  });

  it("click_xy on a canvas on an ad platform fails closed (cannot name what is there)", async () => {
    resolves = [HIT("canvas", { name: "", role: "" })];
    const r = await runWithMoneyGate(ctx, { op: "click_xy", ...PT }, deps());
    expect(r).toMatchObject({ ok: false, error_code: "coordinate_on_money_page" });
    expect(ran()).toBe(false);
  });

  it("click_xy into an opaque payment frame on a checkout page fails closed", async () => {
    resolves = [HIT("frame", { top_url: "https://shop.example.com/cart", name: "", role: "Iframe", page_has_payment_frame: true })];
    const r = await runWithMoneyGate(ctx, { op: "click_xy", ...PT }, deps());
    expect(r).toMatchObject({ ok: false, error_code: "coordinate_on_money_page" });
  });

  it("click_xy on a canvas app (a spreadsheet) runs, pinned to the canvas", async () => {
    resolves = [HIT("canvas", { top_url: "https://docs.google.com/spreadsheets/d/x/edit", frame_url: "https://docs.google.com/spreadsheets/d/x/edit", name: "", role: "" })];
    const d = deps();
    const r = await runWithMoneyGate(ctx, { op: "click_xy", ...PT }, d);
    expect(r.ok).toBe(true);
    expect(runOps(d)[0]).toMatchObject({ op: "click_xy", hit_ref: { backend_node_id: 70 } });
  });

  it("click_xy confirmed, but a different node is at the point now → stale", async () => {
    resolves = [HIT("element"), HIT("element", { hit_ref: { frame_session: null, backend_node_id: 71 } })];
    decisionAfter = approvedBy("member-1");
    const r = await runWithMoneyGate(ctx, { op: "click_xy", ...PT }, deps());
    expect(r).toMatchObject({ ok: false, error_code: "stale" });
    expect(ran()).toBe(false);
  });

  it("drag on an ad budget control is refused; a plain drag runs", async () => {
    const TO = { frame_session: null, backend_node_id: 8 };
    resolves = [{ ...PUBLISH, role: "slider", name: "Daily budget" }, { ...PUBLISH, role: "slider", name: "Daily budget", ref: TO }];
    const r = await runWithMoneyGate(ctx, { op: "drag_ref", ref: REF, to_ref: TO }, deps());
    expect(r).toMatchObject({ ok: false, error_code: "drag_on_money_field" });
    resolves = [HIT("element", { top_url: "https://trello.com/b/1", frame_url: "https://trello.com/b/1", name: "Card 1", role: "listitem" })];
    const d = deps();
    const ok = await runWithMoneyGate(ctx, { op: "drag_xy", ...PT, to_x: 300, to_y: 30 }, d);
    expect(ok.ok).toBe(true);
    expect(runOps(d)[0]).toMatchObject({ op: "drag_xy", hit_ref: { backend_node_id: 70 } });
  });

  const ROW = { name: "Campaign row", role: "listitem" };
  it("drag_xy from a plain row onto a Publish target pauses; the run is pinned at both ends", async () => {
    const S = HIT("element", ROW);
    const D = HIT("element", { hit_ref: { frame_session: null, backend_node_id: 80 } });
    resolves = [S, D, S, D];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    const r = await runWithMoneyGate(ctx, { op: "drag_xy", ...PT, to_x: 300, to_y: 30 }, d);
    expect(r.ok).toBe(true);
    expect((d.read as ReturnType<typeof vi.fn>).mock.calls[1][1]).toEqual({ op: "resolve", ref: null, at: { x: 300, y: 30, shot_w: 500, shot_h: 400 } });
    expect(emitted).toMatchObject({ op: "drag_xy", label: "Publish" });
    expect(runOps(d)[0]).toMatchObject({ op: "drag_xy", hit_ref: { backend_node_id: 70 }, to_hit_ref: { backend_node_id: 80 } });
  });

  it("drag_xy whose drop point is an opaque canvas on a money page fails closed", async () => {
    resolves = [HIT("element", ROW), HIT("canvas", { name: "", role: "" })];
    const r = await runWithMoneyGate(ctx, { op: "drag_xy", ...PT, to_x: 300, to_y: 30 }, deps());
    expect(r).toMatchObject({ ok: false, error_code: "coordinate_on_money_page" });
    expect(ran()).toBe(false);
  });

  it("drag_xy confirmed, but a different node is at the drop point now → stale", async () => {
    const S = HIT("element", ROW);
    resolves = [S, HIT("element", { hit_ref: { frame_session: null, backend_node_id: 80 } }), S, HIT("element", { hit_ref: { frame_session: null, backend_node_id: 81 } })];
    decisionAfter = approvedBy("member-1");
    const r = await runWithMoneyGate(ctx, { op: "drag_xy", ...PT, to_x: 300, to_y: 30 }, deps());
    expect(r).toMatchObject({ ok: false, error_code: "stale" });
    expect(ran()).toBe(false);
  });

  it("drag_ref from a plain row onto a Publish target pauses (the to_ref is judged)", async () => {
    const TO = { frame_session: null, backend_node_id: 8 };
    resolves = [{ ...PUBLISH, ...ROW }, { ...PUBLISH, ref: TO }];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    await runWithMoneyGate(ctx, { op: "drag_ref", ref: REF, to_ref: TO }, d);
    expect((d.read as ReturnType<typeof vi.fn>).mock.calls[1][1]).toEqual({ op: "resolve", ref: TO });
    expect(emitted).toMatchObject({ op: "drag_ref", label: "Publish" });
  });

  it("drag confirmed, but the drop target's form now shows another budget → stale", async () => {
    const S = HIT("element", ROW);
    const D = (v: string) =>
      HIT("element", { name: "Save", hit_ref: { frame_session: null, backend_node_id: 80 }, form: { has_card_field: false, budget_fields: [{ label: "Daily budget", value: v }] } });
    resolves = [S, D("$50"), S, D("$500")];
    decisionAfter = approvedBy("member-1");
    const r = await runWithMoneyGate(ctx, { op: "drag_xy", ...PT, to_x: 300, to_y: 30 }, deps());
    expect(emitted).not.toBeNull();
    expect(r).toMatchObject({ ok: false, error_code: "stale" });
    expect(ran()).toBe(false);
  });

  it("drag from a Boost item onto Publish: the card names Publish", async () => {
    resolves = [HIT("element", { name: "Boost" }), HIT("element", { hit_ref: { frame_session: null, backend_node_id: 80 } })];
    decisionAfter = approvedBy("member-1");
    await runWithMoneyGate(ctx, { op: "drag_xy", ...PT, to_x: 300, to_y: 30 }, deps());
    expect(emitted).toMatchObject({ op: "drag_xy", label: "Publish" });
  });

  it("a prompt answer is never persisted in the decision; the held op keeps it", async () => {
    resolves = [PUBLISH];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    await runWithMoneyGate(ctx, { op: "click_ref", ref: REF, dialog_text: "acct-4111-secret" }, d);
    expect(JSON.stringify(emitted)).not.toContain("acct-4111-secret");
    expect(String(emitted!.op_args)).toContain("[redacted]");
    expect((d.hold as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ dialog_text: "acct-4111-secret" });
    expect(runOps(d)[0]).toMatchObject({ dialog_text: "acct-4111-secret" });
  });

  it("Ctrl+Enter that submits a card form pauses like Enter, pinned to the focused field", async () => {
    resolves = [{ ...PUBLISH, top_url: "https://shop.example.com/checkout", role: "textbox", name: "Card number", is_submit: true, form: { has_card_field: true, budget_fields: [] } }];
    decisionAfter = approvedBy("member-1");
    const d = deps();
    await runWithMoneyGate(ctx, { op: "key_chord", key: "Enter", modifiers: ["Control"] }, d);
    expect(emitted).toMatchObject({ op: "key_chord", reason: "card_form_submit" });
    expect(runOps(d)[0]).toMatchObject({ op: "key_chord", focus_ref: REF });
  });

  it("paste into an ad budget field is refused; Ctrl+A needs no check", async () => {
    resolves = [{ ...PUBLISH, role: "textbox", name: "Daily budget" }];
    const r = await runWithMoneyGate(ctx, { op: "key_chord", key: "v", modifiers: ["Mod"] }, deps());
    expect(r).toMatchObject({ ok: false, error_code: "key_on_money_field" });
    calls.length = 0;
    const a = await runWithMoneyGate(ctx, { op: "key_chord", key: "a", modifiers: ["Mod"] }, deps());
    expect(a.ok).toBe(true);
    expect(calls).toEqual(["run:key_chord"]);
  });

  it("choose on an ad budget dropdown pauses with the change card", async () => {
    resolves = [{ ...PUBLISH, role: "combobox", name: "Budget type" }];
    decisionAfter = approvedBy("member-1");
    await runWithMoneyGate(ctx, { op: "choose", ref: REF, option: "Lifetime budget" }, deps());
    expect(emitted).toMatchObject({ op: "choose", reason: "ad_budget_field", value: "Lifetime budget" });
    expect(emitted!.summary).toBe('On adsmanager.facebook.com I\'m about to change "Budget type" to Lifetime budget.');
  });

  it("reload of a checkout url and back to a pay url pause like a nav; a plain reload runs", async () => {
    decisionAfter = approvedBy("member-1");
    await runWithMoneyGate(ctx, { op: "reload", expect_url: "https://shop.example.com/checkout" }, deps());
    expect(emitted).toMatchObject({ op: "reload", reason: "nav_money_url" });
    expect(emitted!.summary).toBe("On shop.example.com I'm about to open the checkout page.");
    emitted = null;
    decision = null;
    reads = 0;
    await runWithMoneyGate(ctx, { op: "history_go", entry_id: 4, url: "https://shop.example.com/pay/inv_1" }, deps());
    expect(emitted).toMatchObject({ op: "history_go", reason: "nav_money_url" });
    calls.length = 0;
    const plain = await runWithMoneyGate(ctx, { op: "reload", expect_url: "https://shop.example.com/products" }, deps());
    expect(plain.ok).toBe(true);
    expect(calls).toEqual(["run:reload"]);
  });
});
