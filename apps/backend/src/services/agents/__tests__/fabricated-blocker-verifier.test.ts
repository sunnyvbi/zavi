import { describe, it, expect } from "vitest";
import { verifyNoFabricatedBlocker } from "../fabricated-blocker-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output: string,
  status: ToolCallTrace["status"] = "ok",
): ToolCallTrace {
  return { name, input_preview: "", output_preview: output, ms: 12, status };
}

const HANDOFF_OK =
  '{"ok":true,"handed_off_to":"engineer","child_run_id":"run_abc123"}';
const HANDOFF_NO_THREAD =
  '{"error":"handoff_no_thread","message":"praxis__handoff from Slack requires slack_routing (channel + event_id)."}';
const PARALLEL_UNSUPPORTED =
  '{"error":"handoff_parallel_slack_unsupported","message":"parallel handoff is not available on Slack."}';

describe("verifyNoFabricatedBlocker — confabulated platform constraint → soft hedge", () => {
  describe("HEDGES (fabrication with NO grounding error)", () => {
    it("hedges the exact screenshot lie (no handoff attempted)", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "Slack DM handoffs require routing context that isn't available in DM threads, so dispatching to engineer from here fails at the platform level. Paste it into the main chat instead.",
        toolCalls: [trace("memory__search", "{}")],
      });
      expect(r.hedged).toBe(true);
      expect(r.flags.matched_phrases.length).toBeGreaterThan(0);
      expect(r.text).toMatch(/Correction/);
      expect(r.text).toMatch(/dispatch specialists/i);
    });

    it("hedges a 'can't dispatch the engineer from this DM' claim with no error", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "I can't dispatch the engineer from this DM — it's a platform limitation.",
        toolCalls: [],
      });
      expect(r.hedged).toBe(true);
    });

    it("hedges a 'paste it into the web chat' deflection", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "To get the PR moving, paste that into the main web chat — the engineer handoff routes cleanly from there.",
        toolCalls: [],
      });
      expect(r.hedged).toBe(true);
    });

    it("fires even when the handoff tool SUCCEEDED but the model still claims it can't", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "Slack DM handoffs aren't supported here. You'll need to use the web chat.",
        toolCalls: [trace("praxis__handoff", HANDOFF_OK)],
      });
      expect(r.hedged).toBe(true);
    });
  });

  describe("DOES NOT fire (must never mask a real error)", () => {
    it("leaves text alone when a real handoff_no_thread error grounds it", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "I couldn't dispatch the engineer from here — the handoff failed because routing context is missing on this run.",
        toolCalls: [trace("praxis__handoff", HANDOFF_NO_THREAD, "tool_error")],
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.grounded_by_tool_error).toBe(true);
      expect(r.text).not.toMatch(/Correction/);
    });

    it("does NOT treat the by-design handoff_parallel_slack_unsupported as fabricated", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "I can't hand off to multiple specialists at once from Slack — parallel handoff isn't supported on this surface. I'll dispatch them one at a time.",
        toolCalls: [trace("praxis__handoff_parallel", PARALLEL_UNSUPPORTED, "tool_error")],
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.grounded_by_tool_error).toBe(true);
    });

    it("does NOT fire on a normal, non-constraint reply", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "Handing off to @engineer — I'll post the PR here when it's open.",
        toolCalls: [trace("praxis__handoff", HANDOFF_OK)],
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.matched_phrases.length).toBe(0);
    });

    it("ignores a *_not_connected connector error (real grounding)", () => {
      const r = verifyNoFabricatedBlocker({
        reply: "I can't route that from here — GitHub isn't connected for this workspace.",
        toolCalls: [
          trace("github__open_pr", '{"error":"github_not_connected"}', "tool_error"),
        ],
      });
      expect(r.hedged).toBe(false);
    });

    it("empty reply is a no-op", () => {
      const r = verifyNoFabricatedBlocker({ reply: "", toolCalls: [] });
      expect(r.hedged).toBe(false);
    });
  });
});

describe("verifyNoFabricatedBlocker — self-serve read confabulations", () => {
  describe("HEDGES (no grounding error)", () => {
    it("hedges the exact screenshot lie: 'read_file isn't available this run'", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "I couldn't confirm because the read_file tool isn't available this run to read the function bodies directly.",
        toolCalls: [trace("github__search_code", "{}")],
      });
      expect(r.hedged).toBe(true);
      expect(r.text).toMatch(/read the repo directly|lookups are mine/i);
    });

    it("hedges 'github__read_file isn't available'", () => {
      const r = verifyNoFabricatedBlocker({
        reply: "Unfortunately github__read_file is not available, so I can't open it.",
        toolCalls: [],
      });
      expect(r.hedged).toBe(true);
    });

    it("hedges 'I don't have file-read access'", () => {
      const r = verifyNoFabricatedBlocker({
        reply: "I don't have access to read_file so I can only guess from the search hits.",
        toolCalls: [],
      });
      expect(r.hedged).toBe(true);
    });

    it("hedges a read-only lookup-handoff suggestion to engineer", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "Best next step: have the engineer read adminUserController.ts around the reject handler and check whether it calls the email service.",
        toolCalls: [trace("github__search_code", "{}")],
      });
      expect(r.hedged).toBe(true);
      expect(r.text).toMatch(/read the repo directly|lookups are mine/i);
    });

    it("STILL hedges a lookup-handoff even when a read budget was exhausted (budget never justifies routing a read)", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "I hit the read budget. Best next step: have the engineer read adminUserController.ts and check the email call.",
        toolCalls: [
          trace("github__read_file", "BUDGET EXHAUSTED: `github__read_file` has been called 8 times this run (cap: 8)."),
        ],
      });
      expect(r.hedged).toBe(true);
    });
  });

  describe("DOES NOT fire (real grounding, budget-exhaustion, or legitimate action handoff)", () => {
    it("does NOT scold 'read_file isn't available this run' when the read BUDGET cap was hit (it's TRUE then) — the 2026-06-07 false positive", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "No, manual admin rejection does not send an email. One caveat: read_file isn't available this run, so I can't confirm the exact function body of the reject handler.",
        toolCalls: [
          trace("github__read_file", "BUDGET EXHAUSTED: `github__read_file` has been called 8 times this run (cap: 8). You've read enough files this run."),
        ],
      });
      expect(r.hedged).toBe(false);
    });

    it("leaves a genuine github__read_file not_connected error alone", () => {
      const r = verifyNoFabricatedBlocker({
        reply: "github__read_file isn't available — the GitHub connector isn't connected for this workspace.",
        toolCalls: [
          trace("github__read_file", '{"error":"github_not_connected"}', "tool_error"),
        ],
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.grounded_by_tool_error).toBe(true);
    });

    it("does NOT fire when handing off a real ACTION (ship a fix) to the engineer", () => {
      const r = verifyNoFabricatedBlocker({
        reply:
          "Handing off to @engineer to ship the fix and open a PR — I'll post it here.",
        toolCalls: [trace("praxis__handoff", HANDOFF_OK)],
      });
      expect(r.hedged).toBe(false);
      expect(r.flags.matched_phrases.length).toBe(0);
    });
  });
});
