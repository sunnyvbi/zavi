import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_MD = readFileSync(join(__dirname, "..", "agent.md"), "utf-8");

describe("engineer agent — options are delivered in the turn that promises them", () => {
  it("requires every promised option to be enumerated before the turn ends", () => {
    expect(AGENT_MD).toMatch(/Options are atomic with the promise/);
    expect(AGENT_MD).toMatch(/enumerate all N in that SAME assistant turn/i);
    expect(AGENT_MD).toMatch(/every promised numbered item is actually present/i);
  });

  it("covers the observed website clarification failure mode", () => {
    expect(AGENT_MD).toContain('do not make the operator ask "what are the options?"');
    expect(AGENT_MD).toMatch(/meaningful tradeoff and your recommendation/i);
  });
});
