
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "..", "chat-send.ts"), "utf8");

const code = src
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
  .join("\n");

const gateIdx = code.indexOf("hasCurrentExtensionConsent(");

describe("chat-send Chrome-extension consent gate", () => {
  it("asks the consent service, and only on a page-context turn", () => {
    expect(gateIdx).toBeGreaterThan(-1);
    const guard = code.slice(0, gateIdx);
    expect(guard.slice(-400)).toMatch(/if \(body\.page_context\) \{/);
  });

  it("re-derives BOTH ids from the session, never from the request body", () => {
    const call = code.slice(gateIdx, gateIdx + 200);
    expect(call).toMatch(/auth\.tenant_id/);
    expect(call).toMatch(/auth\.user_id/);
    expect(call).not.toMatch(/body\.|req\.body|req\.query|req\.params/);
  });

  it("REFUSES the turn with a 403 the extension can branch on", () => {
    const after = code.slice(gateIdx, gateIdx + 900);
    expect(after).toMatch(/if \(!consented\)/);
    expect(after).toMatch(/res\.status\(403\)/);
    expect(after).toMatch(/code: "consent_required"/);
    expect(after).toMatch(/return;/);
  });

  it("uses plain human wording, with no internal jargon", () => {
    const block = code.slice(gateIdx, gateIdx + 900);
    const msg = block.slice(block.indexOf('code: "consent_required"')).match(/"([^"]{20,})"/)?.[1];
    expect(msg, "could not find the user-visible message").toBeTruthy();
    for (const jargon of [
      "Limited Use",
      "payload",
      "tenant",
      "page_context",
      "policy",
      "RLS",
      "consent_required",
      "403",
    ]) {
      expect(msg!.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });

  it("fires BEFORE the run is created", () => {
    const enqueueIdx = code.indexOf("send_agent_chat_turn");
    expect(enqueueIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(enqueueIdx);
  });

  it("fires BEFORE any page content is normalized or persisted", () => {
    const normalizeIdx = code.indexOf("normalizePageContext(");
    expect(normalizeIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(normalizeIdx);

    const mergeIdx = code.indexOf("PAGE_CONTEXT_SURFACE,", normalizeIdx);
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(mergeIdx);
  });

  it("fires before the barge-in path, which also returns early", () => {
    const bargeIdx = code.indexOf("enqueue_or_steer_chat_turn");
    expect(bargeIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(bargeIdx);
  });
});

describe("chat-send screenshot-mode gate", () => {
  const shotIdx = code.indexOf("validateScreenshotTurn(");

  it("validates the single owned screenshot with session ids and 400s on failure", () => {
    expect(shotIdx).toBeGreaterThan(-1);
    expect(code.slice(shotIdx - 400, shotIdx)).toMatch(/if \(screenshotTurn\) \{/);
    const call = code.slice(shotIdx, shotIdx + 700);
    expect(call).toMatch(/tenant_id: auth\.tenant_id/);
    expect(call).toMatch(/user_id: auth\.user_id/);
    expect(call).toMatch(/image_paths: body\.image_paths/);
    expect(call).toMatch(/if \(!verdict\.ok\)/);
    expect(call).toMatch(/res\.status\(400\)/);
    expect(call).toMatch(/return;/);
  });

  it("runs after the consent gate and before the run is created", () => {
    expect(shotIdx).toBeGreaterThan(gateIdx);
    expect(shotIdx).toBeLessThan(code.indexOf("send_agent_chat_turn"));
    expect(shotIdx).toBeLessThan(code.indexOf("normalizeScreenshotPageContext("));
  });

  it("does NOT re-run the runs-based daily cap for a screenshot turn", () => {
    const capIdx = code.indexOf("checkExtensionDailyCap(");
    expect(capIdx).toBeGreaterThan(-1);
    expect(code.slice(capIdx - 200, capIdx)).toMatch(
      /if \(body\.page_context && !screenshotTurn\) \{/,
    );
  });
});
