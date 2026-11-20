import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const code = readFileSync(join(__dirname, "../chat-send.ts"), "utf8");
const calls = [...code.matchAll(/void flagPreviousReply\(\{/g)].map((m) => m.index ?? -1);

describe("chat-send: team-note follow-up wiring", () => {
  it("has exactly two call sites, both fire-and-forget", () => {
    expect(calls).toHaveLength(2);
    expect(code).not.toMatch(/await flagPreviousReply\(/);
  });

  it("barge-in: flags the in-flight run, inside the steered branch, before the response", () => {
    const steered = code.indexOf('verdict?.action === "steered" && verdict.run_id');
    const respond = code.indexOf("steered: true,", steered);
    expect(calls[0]).toBeGreaterThan(steered);
    expect(calls[0]).toBeLessThan(respond);
    const site = code.slice(calls[0], respond);
    expect(site).toMatch(/inFlightRunId: verdict\.run_id/);
    expect(site).toMatch(/newUserMessageId: verdict\.user_message_id/);
    expect(site).toMatch(/tenantId: auth\.tenant_id/);
  });

  it("normal send / edit: after the chat-turn RPC and after the edit supersede block", () => {
    const rpc = code.indexOf('supabase.rpc("send_agent_chat_turn"');
    const supersede = code.indexOf("supersedeEditedMessage(serviceClient()");
    const editFailed = code.indexOf('code: "edit_supersede_failed"');
    expect(calls[1]).toBeGreaterThan(rpc);
    expect(calls[1]).toBeGreaterThan(supersede);
    expect(calls[1]).toBeGreaterThan(editFailed);
    const site = code.slice(calls[1], calls[1] + 400);
    expect(site).toMatch(/newUserMessageId: user_message_id/);
    expect(site).toMatch(/editOfMessageId: body\.edit_of_message_id/);
  });

  it("no button fast path reaches either site", () => {
    const fastPaths = [
      "build confirm fast path failed",
      "qa deterministic confirm fast path",
      "Chat-approve fast path",
      "Low-intent greeting fast-path",
    ];
    for (const marker of fastPaths) {
      const at = code.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      expect(at, marker).toBeLessThan(calls[0]);
    }
  });
});
