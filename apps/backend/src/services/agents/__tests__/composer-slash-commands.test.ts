import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  COMPOSER_SLASH_COMMANDS,
  composerSlashCommandInstruction,
} from "@zavi/shared";

describe("BUG 15 — agents are told which slash commands exist", () => {
  it("lists every real command, and only those", () => {
    const text = composerSlashCommandInstruction();
    for (const c of COMPOSER_SLASH_COMMANDS) expect(text).toContain(`/${c.name}`);
    expect(COMPOSER_SLASH_COMMANDS.map((c) => c.name).sort()).toEqual([
      "clear",
      "decision",
      "feedback",
      "help",
      "run",
    ]);
  });

  it("scopes itself to what may be RECOMMENDED, not an absolute", () => {
    const text = composerSlashCommandInstruction();
    expect(text).toMatch(/the only ones you may recommend/i);
    expect(text).not.toMatch(/EXACTLY these \d+ commands, and nothing else/i);
  });

  it("names the invented command explicitly so the model cannot re-derive it", () => {
    expect(composerSlashCommandInstruction()).toMatch(/no `?\/schedule`?/i);
    expect(composerSlashCommandInstruction()).toMatch(/NEVER invent a slash command/i);
  });

  it("ships in the fleet-wide prompt, derived and not hand-copied", () => {
    const src = readFileSync(
      join(__dirname, "../generic-dispatcher.ts"),
      "utf8",
    );
    expect(src).toContain("composerSlashCommandInstruction()");
  });

  it("the WEB menu derives from the same constant, so the two cannot drift", () => {
    const registry = readFileSync(
      join(__dirname, "../../../../../web/src/lib/workspace/slashCommandRegistry.ts"),
      "utf8",
    );
    expect(registry).toContain("COMPOSER_SLASH_COMMANDS");
    expect(registry).not.toMatch(/name:\s*"clear",[\s\S]{0,80}kind:\s*"clear"/);
  });
});

describe("BUG 10 — a missing Buffer connection does not block drafting", () => {
  const src = readFileSync(
    join(__dirname, "../../tools/buffer/list_profiles.ts"),
    "utf8",
  );

  it("no longer tells the model that drafting requires OAuth", () => {
    expect(src).not.toContain("before agents can draft social posts");
  });

  it("tells the model to fall back and draft anyway", () => {
    expect(src).toMatch(/does NOT block drafting/i);
    expect(src).toMatch(/fall back to the not-connected path/i);
  });

  it("still says what Buffer IS needed for, so the tool is not now under-explained", () => {
    expect(src).toMatch(/no scheduling or publishing through Buffer/i);
    expect(src).toMatch(/SCHEDULE or PUBLISH/);
  });
});
