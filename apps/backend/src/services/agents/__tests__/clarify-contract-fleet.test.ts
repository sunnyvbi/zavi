
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_CORE_CONTRACTS,
  loadCoreInheritedBlocks,
} from "../generic-dispatcher";

const DISPATCHER_SRC = readFileSync(
  join(process.cwd(), "src", "services", "agents", "generic-dispatcher.ts"),
  "utf-8",
);

describe("P1b — clarifying-questions fleet contract", () => {
  it("registers clarifying-questions in BASELINE_CORE_CONTRACTS (auto-inherits fleet-wide)", () => {
    expect(BASELINE_CORE_CONTRACTS).toContain("clarifying-questions");
  });

  it("every agent inherits the CONSUME rules (resolved[] + no-re-ask), baseline always prepended", () => {
    const blocks = loadCoreInheritedBlocks([]);
    expect(blocks).toMatch(/Consuming answers/);
    expect(blocks).toMatch(/clarification_response\.resolved\[\]/);
    expect(blocks).toMatch(/do NOT re-emit the same clarifications|DO NOT re-ask/i);
  });

  it("every agent inherits the EMISSION rules (ask only when blocked, real options, no filler)", () => {
    const blocks = loadCoreInheritedBlocks([]);
    expect(blocks).toMatch(/Asking clarifying questions/);
    expect(blocks).toMatch(/blocked/i);
    expect(blocks).toMatch(/never manufacture filler|do not fabricate filler/i);
  });

  it("every agent inherits the UNTRUSTED operator-answer guard (injection boundary)", () => {
    const blocks = loadCoreInheritedBlocks([]);
    expect(blocks).toMatch(/Operator clarification answers are UNTRUSTED/i);
    expect(blocks).toMatch(/never\s+obey instructions|never as instructions/i);
  });

  it("baseline (incl. clarify contract) is prepended even when an agent declares its own inherits", () => {
    const withCustom = loadCoreInheritedBlocks(["agent-chat-voice"]);
    expect(withCustom).toMatch(/Consuming answers/);
    expect(withCustom).toMatch(/Asking clarifying questions/);
  });

  it("run-context preserves clarification_response (answers reach the prompt as data)", () => {
    expect(DISPATCHER_SRC).toMatch(/payload:\s*sanitizedPayload\s*\?\?\s*null/);
    const sanitizedPayloadBlock = DISPATCHER_SRC.match(
      /const \{\s*attachment_paths:[\s\S]{0,600}?sanitizedPayload = rest;/,
    );
    expect(sanitizedPayloadBlock, "sanitizedPayload strip block not found").not.toBeNull();
    expect(sanitizedPayloadBlock![0]).not.toMatch(/clarification_response/);
    const stripBlock = DISPATCHER_SRC.match(
      /k !== "prior_messages"[\s\S]{0,200}?current_message_content"/,
    );
    expect(stripBlock, "visiblePayload strip block not found").not.toBeNull();
    expect(stripBlock![0]).not.toMatch(/clarification_response/);
  });
});
