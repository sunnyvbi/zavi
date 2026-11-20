import { describe, expect, it } from "vitest";
import { RESERVED_RUN_PAYLOAD_KEYS, stripReservedRunPayloadKeys } from "../reserved-payload";

describe("stripReservedRunPayloadKeys", () => {
  it("drops every reserved key and keeps the rest, without touching the input", () => {
    const input: Record<string, unknown> = { message: "hi", repo_hint: "a/b" };
    for (const k of RESERVED_RUN_PAYLOAD_KEYS) input[k] = "forged";
    const out = stripReservedRunPayloadKeys(input);
    expect(out).toEqual({ message: "hi", repo_hint: "a/b" });
    expect(input.source_decision_id).toBe("forged");
  });
  it("covers the provenance keys the dispatcher and the gates read", () => {
    for (const k of ["source_decision_id", "origin_decision_id", "dispatched_by", "cgo_hire", "cgo_brief", "goal_id", "goal_rev", "problem", "current_user_text_raw"]) {
      expect(RESERVED_RUN_PAYLOAD_KEYS).toContain(k);
    }
  });
  it("covers the free fix markers the credit waivers read, so a client can never send them", () => {
    for (const k of ["brief_journey_fix", "brief_journey_fix_token", "vision_fix", "vision_fix_token"]) {
      expect(RESERVED_RUN_PAYLOAD_KEYS).toContain(k);
    }
  });
  it("covers the build markers, so a client can never claim a run is a build or an edit", () => {
    for (const k of ["build_conductor_run_id", "refine_mode"]) expect(RESERVED_RUN_PAYLOAD_KEYS).toContain(k);
  });
  it("covers the turn and resume ancestry the owner-photo resolver trusts", () => {
    for (const k of ["user_message_id", "resume_of_run_id", "internal_resume_turn", "operator_thread_id", "attachment_paths"]) {
      expect(RESERVED_RUN_PAYLOAD_KEYS).toContain(k);
    }
    const out = stripReservedRunPayloadKeys({ message: "x", resume_of_run_id: "victim-run", user_message_id: "m", attachment_paths: [] });
    expect(out).toEqual({ message: "x" });
  });
  it("reserves the identity keys, so an MCP / a2a / manual caller cannot name a member's thread or actor", () => {
    expect(stripReservedRunPayloadKeys({ message: "x", thread_id: "victim-thread", inherited_actor: { actor_user_id: "victim" }, user_message_id: "m" })).toEqual({ message: "x" });
  });
  it("leaves a non-object alone", () => {
    expect(stripReservedRunPayloadKeys(null)).toBeNull();
    expect(stripReservedRunPayloadKeys("x")).toBe("x");
    expect(stripReservedRunPayloadKeys([1])).toEqual([1]);
  });
  it("reserves email_plan, so no client can start a planned-draft or planning run (POST /run, a2a, MCP strip it)", () => {
    expect(RESERVED_RUN_PAYLOAD_KEYS).toContain("email_plan");
    expect(stripReservedRunPayloadKeys({ message: "x", email_plan: { mode: "planned_draft", item_id: "i", version: 1 } })).toEqual({ message: "x" });
  });
  it("reserves staff_model, so a client can never pick a model through a run payload", () => {
    expect(RESERVED_RUN_PAYLOAD_KEYS).toContain("staff_model");
  });
});
