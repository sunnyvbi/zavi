
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "..", "chat-send.ts"), "utf8");
const code = src
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
  .join("\n");

describe("chat-send Build-view binding", () => {
  const checkIdx = code.indexOf("isOwnedBuildSession(serviceClient() as unknown as BindingDb, auth.tenant_id, body.build_session_id)");
  const stampIdx = code.indexOf("[BUILD_SESSION_PAYLOAD_KEY]: buildSessionId");
  const enqueueIdx = code.indexOf("send_agent_chat_turn");

  it("validates the client id against the SESSION tenant before anything is written", () => {
    expect(checkIdx).toBeGreaterThan(-1);
    expect(enqueueIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(enqueueIdx);
  });

  it("stamps only the validated id, scoped to the run and the session tenant, before dispatch", () => {
    expect(stampIdx).toBeGreaterThan(enqueueIdx);
    const block = code.slice(stampIdx - 1100, stampIdx + 300);
    expect(block).toMatch(/if \(buildSessionId\)/);
    expect(block).toMatch(/\.eq\("tenant_id", auth\.tenant_id\)/);
    expect(block).not.toMatch(/body\.build_session_id/);
    expect(block).toMatch(/error: bsReadErr \}/);
    expect(block).toMatch(/if \(bsReadErr \|\| !bsRun\) \{[\s\S]*?\} else \{[\s\S]*?\.update\(\{ payload: \{ \.\.\.bsBase, \[BUILD_SESSION_PAYLOAD_KEY\]: buildSessionId \} \}\)/);
    const dispatchIdx = code.indexOf("agent.run.requested", stampIdx);
    if (dispatchIdx > -1) expect(stampIdx).toBeLessThan(dispatchIdx);
  });

  it("refuses a named build that is foreign, unknown or unreadable, for EVERY agent, before anything is written", () => {
    const guard = code.slice(checkIdx - 200, checkIdx + 1200);
    expect(code.slice(checkIdx - 200, checkIdx)).toMatch(/if \(body\.build_session_id\) \{/);
    expect(guard).toMatch(/code: "build_session_check_failed"[\s\S]*?return;/);
    expect(guard).toMatch(/if \(!owned\) \{\s*res\.status\(404\)[\s\S]*?code: "build_session_not_found"[\s\S]*?return;/);
    expect(guard).toMatch(/res\.status\(503\)/);
    expect(checkIdx).toBeLessThan(code.indexOf('slug === "operator" && body.build_session_id'));
  });

  it("refuses an @agent turn from a SITE's Build chat instead of letting it pick a repo", () => {
    const refuseIdx = code.indexOf('code: "site_edit_via_build_chat"');
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(refuseIdx).toBeLessThan(enqueueIdx);
    const guard = code.slice(refuseIdx - 1200, refuseIdx);
    expect(guard).toMatch(/slug !== "operator" && body\.build_session_id/);
    expect(guard).toMatch(/loadSiteForRun\?\.\(auth\.tenant_id, body\.build_session_id\)/);
    expect(code.slice(refuseIdx, refuseIdx + 400)).toMatch(/return;/);
  });

  it("a Build turn does not barge into a thread bound to another build", () => {
    const bargeIdx = code.indexOf("enqueue_or_steer_chat_turn");
    expect(code.slice(bargeIdx - 2500, bargeIdx)).toMatch(
      /\(!buildSessionId \|\| threadBoundTo === buildSessionId\)/,
    );
  });
});
