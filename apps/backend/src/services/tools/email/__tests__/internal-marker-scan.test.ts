
import { describe, it, expect } from "vitest";
import { scanInternalMarkers } from "../internal-marker-scan";

const REAL_LEAKED_BODY = [
  "Queued for your approval (decision_id `ec5acce2`). Approve at `/workspace?tab=approvals` to send.",
  "",
  "**Reply to ravi@upcar.ai:** 247 active hosts right now — live pull as of today (approved hosts with active account status). This matches the prior pull from earlier today.",
].join("\n");

describe("scanInternalMarkers — what a customer may read", () => {
  it("strips a Needs you workspace link the same way (2026-10-17)", () => {
    const r = scanInternalMarkers("Open it at https://www.zaviagent.com/workspace?tab=needs-you to approve.\n\nHosts: 247 active.");
    expect(r.clean).not.toMatch(/tab=needs-you/);
    expect(r.clean).toContain("247 active");
    expect(r.stripped).toContain("needs_you_url");
  });

  it("keeps the answer and strips the approval plumbing (the real 2026-07-13 leak)", () => {
    const r = scanInternalMarkers(REAL_LEAKED_BODY);
    expect(r.empty).toBe(false);
    expect(r.clean).toContain("247 active hosts right now");
    expect(r.clean).not.toMatch(/queued for your approval/i);
    expect(r.clean).not.toMatch(/decision_id/i);
    expect(r.clean).not.toMatch(/workspace\?tab=approvals/i);
    expect(r.clean).not.toMatch(/ec5acce2/);
    expect(r.clean).not.toMatch(/^\*\*Reply to/i);
    expect(r.stripped).toContain("approval_queued");
  });

  it("leaves a clean human answer completely untouched", () => {
    const clean = "You had 247 active hosts last week, up 12 from the week before.";
    const r = scanInternalMarkers(clean);
    expect(r.clean).toBe(clean);
    expect(r.stripped).toEqual([]);
    expect(r.empty).toBe(false);
  });

  it("strips internal tool + run identifiers", () => {
    const r = scanInternalMarkers(
      [
        "I'll route this via praxis__handoff to the support specialist.",
        "Your refund was processed yesterday.",
        "agent_run_id: 77f06982",
      ].join("\n"),
    );
    expect(r.clean).toBe("Your refund was processed yesterday.");
    expect(r.stripped).toEqual(expect.arrayContaining(["praxis_tool", "run_id_marker"]));
  });

  it("flags empty when the output was ONLY plumbing, so the caller refuses to send", () => {
    const r = scanInternalMarkers(
      "Queued for your approval (decision_id `abc123`). Approve at `/workspace?tab=approvals` to send.",
    );
    expect(r.empty).toBe(true);
  });

  it("does not mistake ordinary prose for a marker", () => {
    const body = "We made the decision to refund the guest, and the payout is on its way.";
    const r = scanInternalMarkers(body);
    expect(r.clean).toBe(body);
    expect(r.empty).toBe(false);
  });
});
