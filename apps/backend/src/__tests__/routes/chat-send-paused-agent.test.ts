import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "..", "routes", "agents", "chat-send.ts"),
  "utf8",
);

function pausedBlock(): string {
  const start = SRC.indexOf("// Paused-agent chat guard (2026-06-20).");
  const end = SRC.indexOf("// requires_sandbox merge:");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("Could not locate the paused-agent guard block — chat-send.ts layout changed?");
  }
  return SRC.slice(start, end);
}

describe("chat-send — paused-agent chat guard (2026-06-20)", () => {
  const block = pausedBlock();

  it("reads the kill-switch for THIS tenant + agent via the canonical isAgentKilled (override_state='hidden' only — a 'visible' opt-in is NOT a kill)", () => {
    expect(block).toMatch(/isAgentKilled\(auth\.tenant_id, slug\)/);
    expect(block).not.toMatch(/from\("tenant_agent_kill_switch"\)/);
  });

  it("cancels the doomed queued run with a CAS on status='queued' (never clobbers a claimed row)", () => {
    expect(block).toMatch(/status: "cancelled"/);
    expect(block).toMatch(/\.eq\("id", run_id\)/);
    expect(block).toMatch(/\.eq\("status", "queued"\)/);
  });

  it("answers with a clean assistant 'paused' bubble, no run attached", () => {
    expect(block).toMatch(/sender_role: "assistant"/);
    expect(block).toMatch(/is paused/);
    expect(block).toMatch(/agent_paused: true/);
    expect(block).toMatch(/agent_run_id: null/);
  });

  it("returns before any Inngest dispatch (no doomed event)", () => {
    expect(block).toMatch(/paused: true/);
    expect(block).toMatch(/return;/);
  });

  it("runs before the requires_sandbox branch so it covers every agent class", () => {
    expect(SRC.indexOf("// Paused-agent chat guard (2026-06-20).")).toBeLessThan(
      SRC.indexOf("if (def.metadata_praxis.requires_sandbox) {"),
    );
  });
});
