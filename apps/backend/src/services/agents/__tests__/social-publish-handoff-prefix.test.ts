
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS } from "@zavi/shared";
import {
  CHAT_STAGEABLE_CHANNEL_NAMES,
  SOCIAL_PUBLISH_HANDOFF_INSTRUCTION,
  buildSystemPromptForTest,
} from "../generic-dispatcher";
import { socialChannelAvailabilityLine } from "@/services/connectors/social-channels";

describe("SOCIAL_PUBLISH_HANDOFF_INSTRUCTION", () => {
  it("states plainly that the agent has no publishing tool", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/NO tool that posts/i);
  });

  it("does NOT claim the agent cannot stage — growth-lead can, verified live", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).not.toMatch(/none that .*stages/i);
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(
      /If your own output format can stage/i,
    );
  });

  it("allows the one true claim — 'staged', never 'posted'", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/strongest true statement is that you STAGED/);
  });

  it("says the handoff is required even when declining or when nothing is connected", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/missing connector is NOT a dead end/i);
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/EVERY time publishing is asked for/);
  });

  it("blocks the invented copy-and-paste fallback", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/no copy-and-paste mode/i);
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/Never tell the operator to paste the post themselves/i);
  });

  it("forbids claiming a post was made — the dangerous failure mode", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(
      /Never say or imply you posted, published, shared, or scheduled/i,
    );
  });

  it("names the exact handoff so the operator isn't left guessing", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/@mention/);
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/Channels/);
  });

  it("never points at the removed composer \"Propose post\" button (QA sheet #9)", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).not.toMatch(/Propose post/i);
  });

  it("only offers the @mention handoff for channels whose agent can actually stage", () => {
    const agentsDir = join(__dirname, "../../../agents");
    const granted = readdirSync(agentsDir)
      .filter((dir) => existsSync(join(agentsDir, dir, "agent.md")))
      .filter((dir) =>
        /^\s*-\s*social__propose_post\s*$/m.test(
          readFileSync(join(agentsDir, dir, "agent.md"), "utf-8"),
        ),
      );
    const grantedNames = CHANNELS.filter((c) => granted.includes(c.executor))
      .map((c) => c.name)
      .sort();
    expect([...CHAT_STAGEABLE_CHANNEL_NAMES].sort()).toEqual(grantedNames);
    for (const name of CHAT_STAGEABLE_CHANNEL_NAMES) {
      expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toContain(name);
    }
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/not available for it yet/);
  });

  it("still asks the agent to do the half it CAN do — write the copy", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/write the post copy/i);
  });

  it("lists only the channels that are actually enabled today", () => {
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toContain(socialChannelAvailabilityLine());
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/LinkedIn personal profile/);
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/Reddit/);
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).toMatch(/are NOT available/);
    expect(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION).not.toMatch(
      /X, LinkedIn company pages, Instagram and YouTube are NOT available/,
    );
  });
});

describe("stable prompt prefix", () => {
  const prompt = buildSystemPromptForTest({
    body_markdown: "# test agent",
    memory: { company: "c", ops: "o" },
    run_context: {},
  });

  it("appends the handoff instruction exactly ONCE", () => {
    const hits = prompt.split("## Publishing to social media").length - 1;
    expect(hits).toBe(1);
  });

  it("every agent inherits it — it is in the shared prefix, not one agent.md", () => {
    expect(prompt).toContain(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION);
  });
});
