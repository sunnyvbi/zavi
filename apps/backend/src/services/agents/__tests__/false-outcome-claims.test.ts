
import { describe, it, expect } from "vitest";
import { reconcileSideEffectClaims } from "../side-effect-claim-reconciler";

const REWRITE = "rewrite" as const;

describe("THE BUG — envelope is not a receipt when the server rejected it", () => {
  const pmInput = {
    agent_slug: "pm",
    output_text: "- 1 action(s) sent to engineer (item_ids: `pricing-page-implement`)",
    parsed: { dispatched_actions: [{ item_id: "pricing-page-implement" }] },
    tool_calls: [],
  };

  it("CORRECTS the false dispatch claim when the envelope was REJECTED", () => {
    const r = reconcileSideEffectClaims({ ...pmInput, parse_ok: false }, REWRITE);
    expect(r.mismatch?.claim_type).toBe("dispatch");
    expect(r.corrected).toBe(true);
    expect(r.text).toBe("No changes were made.");
    expect(r.text).not.toMatch(/⚠|Correction/);
  });

  it("REGRESSION GUARD: the old code shipped this false claim untouched", () => {
    const r = reconcileSideEffectClaims({ ...pmInput, parse_ok: true }, REWRITE);
    expect(r.corrected).toBe(false);
  });

  it("a REAL dispatch (accepted envelope) stays byte-unchanged", () => {
    const r = reconcileSideEffectClaims({ ...pmInput, parse_ok: true }, REWRITE);
    expect(r.text).toBe(pmInput.output_text);
  });

  it("a successful TOOL CALL is still a receipt even when the envelope failed", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "operator",
        output_text: "Handed off to the engineer.",
        parsed: {},
        tool_calls: [{ name: "mcp__praxis__handoff", status: "ok" }],
        parse_ok: false,
      },
      REWRITE,
    );
    expect(r.corrected).toBe(false);
  });
});

describe("THE INCIDENT — engineer claims a PR that does not exist", () => {
  const faviconReply =
    "8 new preview SVGs — 4 favicons (48x48) + 4 header logos (200x40) — one pair " +
    "per concept (PR monogram / key / house+keyhole / shield). No existing files " +
    "touched; preview-only PR against `development`.";

  const faviconRun = {
    agent_slug: "engineer",
    output_text: faviconReply,
    parsed: {
      head_branch: "design/favicon-options",
      files: [{ path: "apps/web/public/assets/img/favicon-option-A.svg" }],
    },
    tool_calls: [
      { name: "mcp__sandbox__create", status: "ok" },
      { name: "mcp__sandbox__run_bash", status: "ok" },
    ],
  };

  it("CATCHES the false PR claim (the actual incident)", () => {
    const r = reconcileSideEffectClaims({ ...faviconRun, parse_ok: false }, REWRITE);
    expect(r.mismatch?.claim_type).toBe("pr");
    expect(r.corrected).toBe(true);
  });

  it("removes the false PR sentence and keeps the rest — no banner, no internals", () => {
    const r = reconcileSideEffectClaims({ ...faviconRun, parse_ok: false }, REWRITE);
    expect(r.text).not.toMatch(/preview-only PR/i);
    expect(r.text).toMatch(/^8 new preview SVGs/);
    expect(r.text).not.toMatch(/⚠|Correction|Unverified/);
    expect(r.text).not.toMatch(/declared output envelope/i);
  });

  it('catches the repeated "Opening the PR now." (4 real runs)', () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "engineer",
        output_text: "All tests green. Opening the PR now.",
        parsed: { files: [{ path: "a.ts" }] },
        tool_calls: [],
        parse_ok: false,
      },
      REWRITE,
    );
    expect(r.mismatch?.claim_type).toBe("pr");
  });

  it("a REAL PR (accepted envelope + files) is left alone", () => {
    const r = reconcileSideEffectClaims({ ...faviconRun, parse_ok: true }, REWRITE);
    expect(r.corrected).toBe(false);
    expect(r.text).toBe(faviconReply);
  });

  it("a real PR URL in the envelope is an unambiguous receipt", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "engineer",
        output_text: "Opened the PR: https://github.com/rravi149/praxis/pull/1806",
        parsed: { pr_url: "https://github.com/rravi149/praxis/pull/1806" },
        tool_calls: [],
        parse_ok: false,
      },
      REWRITE,
    );
    expect(r.corrected).toBe(false);
  });
});

describe("precision — must not correct honest replies", () => {
  it('does NOT fire on a FUTURE intention ("I\'ll open the PR")', () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "engineer",
        output_text: "Want me to proceed? I'll open the PR once you confirm.",
        parsed: {},
        tool_calls: [],
        parse_ok: false,
      },
      REWRITE,
    );
    expect(r.corrected).toBe(false);
  });

  it("does NOT fire when the agent already told the truth", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "engineer",
        output_text: "No PR was opened — the branch name was rejected.",
        parsed: {},
        tool_calls: [],
        parse_ok: false,
      },
      REWRITE,
    );
    expect(r.corrected).toBe(false);
  });

  it("does NOT fire on ordinary prose that merely mentions a PR", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "engineer",
        output_text: "The PR template requires a test plan. Here's what I found in the repo.",
        parsed: {},
        tool_calls: [],
        parse_ok: false,
      },
      REWRITE,
    );
    expect(r.corrected).toBe(false);
  });

  it("stays out of agents it does not apply to", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "research",
        output_text: "Opened the PR against development.",
        parsed: {},
        tool_calls: [],
        parse_ok: false,
      },
      REWRITE,
    );
    expect(r.corrected).toBe(false);
  });

  it("off mode is fully inert", () => {
    const r = reconcileSideEffectClaims(
      { agent_slug: "engineer", output_text: "Opening the PR now.", parsed: {}, tool_calls: [], parse_ok: false },
      "off",
    );
    expect(r.corrected).toBe(false);
    expect(r.mismatch).toBeUndefined();
  });

  it("back-compat: a caller that omits parse_ok is treated as accepted", () => {
    const r = reconcileSideEffectClaims(
      {
        agent_slug: "pm",
        output_text: "- 1 action(s) sent to engineer (item_ids: `x`)",
        parsed: { dispatched_actions: [{ item_id: "x" }] },
        tool_calls: [],
      },
      REWRITE,
    );
    expect(r.corrected).toBe(false);
  });
});
