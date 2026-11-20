import { describe, it, expect, vi } from "vitest";
import { draftFailure, ensureStarterPrompts, hasPastYear } from "../prompts";
import type { GeoPrompt, StarterDeps } from "../prompts";

const prompt = (id: string, status: GeoPrompt["status"]): GeoPrompt => ({
  id,
  prompt_text: `question ${id}`,
  source: "zavi",
  status,
  rationale: null,
  created_at: "2026-09-18T00:00:00.000Z",
  status_changed_at: "2026-09-18T00:00:00.000Z",
});

const TID = "11111111-1111-1111-1111-111111111111";

type Suggest = StarterDeps["suggest"];
type Accept = StarterDeps["accept"];
type List = StarterDeps["list"];
type Check = StarterDeps["check"];
type Stale = StarterDeps["stale"];
type Archive = StarterDeps["archive"];
type Site = StarterDeps["site"];

function store(initial: GeoPrompt[] = []) {
  const rows = [...initial];
  const suggest = vi.fn<Parameters<Suggest>, ReturnType<Suggest>>(async () => {
    const drafts = [prompt("s1", "suggested"), prompt("s2", "suggested")];
    rows.push(...drafts);
    return { ok: true, suggestions: drafts };
  });
  const accept = vi.fn<Parameters<Accept>, ReturnType<Accept>>(async (_t, ids) => {
    const accepted: string[] = [];
    for (const r of rows) {
      if (ids.includes(r.id) && r.status === "suggested") {
        r.status = "active";
        accepted.push(r.id);
      }
    }
    return { accepted, left_suggested: ids.filter((i) => !accepted.includes(i)) };
  });
  const list = vi.fn<Parameters<List>, ReturnType<List>>(async () => ({
    active: rows.filter((r) => r.status === "active"),
    suggested: rows.filter((r) => r.status === "suggested"),
  }));
  const check = vi.fn<Parameters<Check>, ReturnType<Check>>(async () => ({ fits: true, reason: "" }));
  const stale = vi.fn<Parameters<Stale>, ReturnType<Stale>>(async () => false);
  const archive = vi.fn<Parameters<Archive>, ReturnType<Archive>>(async (_t, id) => {
    const row = rows.find((r) => r.id === id);
    if (row) row.status = "archived";
    return !!row;
  });
  const site = vi.fn<Parameters<Site>, ReturnType<Site>>(async () => ["Example | what the company sells"]);
  return { rows, deps: { list, suggest, accept, check, stale, archive, site } };
}

describe("ensureStarterPrompts", () => {
  it("drafts and accepts a first set when there is none", async () => {
    const { deps } = store();
    const r = await ensureStarterPrompts(TID, deps);

    expect(r).toMatchObject({ ok: true, state: "started", accepted: 2 });
    expect(deps.suggest).toHaveBeenCalledTimes(1);
    expect(r.ok && r.active.map((p) => p.id)).toEqual(["s1", "s2"]);
  });

  it("leaves an existing set alone and never calls the model", async () => {
    const { deps } = store([prompt("a1", "active")]);
    const r = await ensureStarterPrompts(`${TID.slice(0, -1)}2`, deps);

    expect(r).toMatchObject({ ok: true, state: "already_set", accepted: 0 });
    expect(deps.suggest).not.toHaveBeenCalled();
  });

  it("leaves drafts already waiting for a person, and drafts nothing on top", async () => {
    const { rows, deps } = store([prompt("w1", "suggested")]);
    const r = await ensureStarterPrompts(`${TID.slice(0, -1)}3`, deps);

    expect(deps.suggest).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, state: "needs_review", accepted: 0 });
    expect(rows.map((x) => x.status)).toEqual(["suggested"]);
  });

  it("holds a draft that does not fit the company instead of tracking it", async () => {
    const { rows, deps } = store();
    deps.check.mockResolvedValue({ fits: false, reason: "questions are about a different product" });
    const r = await ensureStarterPrompts(`${TID.slice(0, -1)}7`, deps);

    expect(r).toMatchObject({ ok: true, state: "needs_review", accepted: 0 });
    expect(deps.accept).not.toHaveBeenCalled();
    expect(rows.map((x) => x.status)).toEqual(["suggested", "suggested"]);
  });

  it("checks the drafted questions themselves", async () => {
    const { deps } = store();
    const tid = `${TID.slice(0, -1)}8`;
    await ensureStarterPrompts(tid, deps);

    expect(deps.check).toHaveBeenCalledWith(tid, ["question s1", "question s2"], expect.anything());
  });

  it("replaces an outgrown starter set once the new draft passes", async () => {
    const { rows, deps } = store([prompt("old1", "active"), prompt("old2", "active")]);
    deps.stale.mockResolvedValue(true);
    const r = await ensureStarterPrompts(`${TID.slice(0, -1)}9`, deps);

    expect(r).toMatchObject({ ok: true, state: "started", accepted: 2 });
    expect(r.ok && r.active.map((p) => p.id)).toEqual(["s1", "s2"]);
    expect(rows.filter((x) => x.status === "archived").map((x) => x.id)).toEqual(["old1", "old2"]);
  });

  it("keeps an outgrown set when its replacement was declined before it could be tracked", async () => {
    const { rows, deps } = store([prompt("old1", "active")]);
    deps.stale.mockResolvedValue(true);
    deps.accept.mockResolvedValue({ accepted: [], left_suggested: ["s1", "s2"] });
    await ensureStarterPrompts(`${TID.slice(0, -1)}b`, deps);

    expect(deps.archive).not.toHaveBeenCalled();
    expect(rows.find((x) => x.id === "old1")?.status).toBe("active");
  });

  it("does not pay for a second replacement draft right after an empty one", async () => {
    const { deps } = store([prompt("old1", "active")]);
    deps.stale.mockResolvedValue(true);
    deps.suggest.mockResolvedValue({ ok: true, suggestions: [] });
    const tid = `${TID.slice(0, -1)}c`;
    await ensureStarterPrompts(tid, deps);
    const again = await ensureStarterPrompts(tid, deps);

    expect(deps.suggest).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ ok: true, state: "already_set" });
  });

  it("keeps an outgrown set when its replacement fails the check", async () => {
    const { rows, deps } = store([prompt("old1", "active")]);
    deps.stale.mockResolvedValue(true);
    deps.check.mockResolvedValue({ fits: false, reason: "no" });
    const r = await ensureStarterPrompts(`${TID.slice(0, -1)}a`, deps);

    expect(r).toMatchObject({ ok: true, state: "needs_review", accepted: 0 });
    expect(deps.archive).not.toHaveBeenCalled();
    expect(rows.find((x) => x.id === "old1")?.status).toBe("active");
  });

  it("passes the model's own refusal straight through", async () => {
    const { deps } = store();
    deps.suggest.mockResolvedValue({
      ok: false,
      code: "brand_unknown",
      message: "Add your company name in Settings first, so Zavi can draft unbranded prompts.",
    });
    const r = await ensureStarterPrompts(`${TID.slice(0, -1)}4`, deps);

    expect(r).toMatchObject({ ok: false, code: "brand_unknown" });
  });

  it("coalesces two panels opening at once into one draft", async () => {
    const { deps } = store();
    const tid = `${TID.slice(0, -1)}5`;
    const [a, b] = await Promise.all([
      ensureStarterPrompts(tid, deps),
      ensureStarterPrompts(tid, deps),
    ]);

    expect(deps.suggest).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.ok && a.active).toHaveLength(2);
  });

  it("reads the site once and hands the same lines to the draft and the check", async () => {
    const { deps } = store();
    await ensureStarterPrompts(`${TID.slice(0, -1)}d`, deps);

    expect(deps.site).toHaveBeenCalledTimes(1);
  });

  it("does not pay for a second first draft right after an empty one", async () => {
    const { deps } = store();
    deps.suggest.mockResolvedValue({ ok: true, suggestions: [] });
    const tid = `${TID.slice(0, -1)}e`;
    await ensureStarterPrompts(tid, deps);
    await ensureStarterPrompts(tid, deps);

    expect(deps.suggest).toHaveBeenCalledTimes(1);
  });

  it("reports an empty draft rather than claiming a set exists", async () => {
    const { deps } = store();
    deps.suggest.mockResolvedValue({ ok: true, suggestions: [] });
    const r = await ensureStarterPrompts(`${TID.slice(0, -1)}6`, deps);

    expect(r).toMatchObject({ ok: true, state: "started", accepted: 0 });
    expect(r.ok && r.active).toEqual([]);
  });
});

describe("hasPastYear", () => {
  const now = new Date("2026-10-10T00:00:00Z");

  it("flags a question dated to an earlier year", () => {
    expect(hasPastYear("what is the best AI assistant for everyday tasks in 2024", now)).toBe(true);
  });

  it("flags a past year trailing the question or used mid-sentence as a date", () => {
    expect(hasPastYear("best running shoes 2024", now)).toBe(true);
    expect(hasPastYear("best CRM in 2024 for a small team", now)).toBe(true);
    expect(hasPastYear("best 2024 CRM for a small team", now)).toBe(true);
  });

  it("passes the current year and a later one", () => {
    expect(hasPastYear("best running shoes 2026", now)).toBe(false);
    expect(hasPastYear("conference venues for 2027", now)).toBe(false);
  });

  it("passes a year that is the subject, not the date", () => {
    expect(hasPastYear("best insurance for a 2020 hatchback", now)).toBe(false);
    expect(hasPastYear("where can I buy a used 2020 hatchback", now)).toBe(false);
    expect(hasPastYear("what is the best CRM in 2024", now)).toBe(true);
    expect(hasPastYear("how do I run tryouts for a club with 2000 kids", now)).toBe(false);
  });
});

describe("draftFailure — the provider's words never reach the founder", () => {
  const anthropic429 =
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"req_011CfA7DgGb4uxqruJL5dtCP"}';

  it("turns a rate limit into a sentence that says come back", () => {
    const r = draftFailure(anthropic429);
    expect(r).toMatchObject({ code: "draft_unavailable" });
    expect(r.message).toMatch(/try again in a minute/i);
    expect(r.message).not.toMatch(/429|request_id|rate_limit_error|\{/);
  });

  it("treats an overload and a timeout the same way", () => {
    expect(draftFailure("Overloaded")).toMatchObject({ code: "draft_unavailable" });
    expect(draftFailure("socket hang up: ETIMEDOUT")).toMatchObject({ code: "draft_unavailable" });
  });

  it("never tells a founder the model is rate-limited", () => {
    for (const detail of [anthropic429, "Overloaded", "usage limit reached", "TypeError: x"]) {
      expect(draftFailure(detail).message).not.toMatch(/rate.?limit/i);
    }
  });

  it("does not promise a retry will help when the fault is ours", () => {
    const r = draftFailure("TypeError: cannot read property 'suggestions' of undefined");
    expect(r).toMatchObject({ code: "write_failed" });
    expect(r.message).not.toMatch(/TypeError|undefined/);
  });
});
