import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "..", "routes", "agents", "chat-send.ts"),
  "utf8",
);

describe("chat-send — repository-access preflight ordering", () => {
  const ownershipGuard = SRC.indexOf("// API-hygiene PR 2026-05-26 (GAP F)");
  const pausedGuard = SRC.indexOf("// Paused-agent chat guard (2026-06-20).");
  const repoPreflight = SRC.indexOf("// Repo-access preflight (2026-06-09 census failure #2)");
  const chatTurnRpc = SRC.indexOf('supabase.rpc("send_agent_chat_turn"');

  it("checks ownership and the kill-switch before repository access and persistence", () => {
    expect(ownershipGuard).toBeGreaterThan(-1);
    expect(pausedGuard).toBeGreaterThan(ownershipGuard);
    expect(repoPreflight).toBeGreaterThan(pausedGuard);
    expect(chatTurnRpc).toBeGreaterThan(repoPreflight);
  });

  it("has exactly one repository-access fallback", () => {
    expect(SRC.match(/Repo-access preflight \(2026-06-09 census failure #2\)/g)).toHaveLength(1);
  });

  it("returns from the blocked fallback before the chat-turn RPC", () => {
    const fallback = SRC.slice(repoPreflight, chatTurnRpc);
    expect(fallback).toContain('action: "repo_access_blocked"');
    expect(fallback).toMatch(/action: "repo_access_blocked"[\s\S]*?return;/);
  });
});
