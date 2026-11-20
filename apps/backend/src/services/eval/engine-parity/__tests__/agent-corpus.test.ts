
import { describe, expect, it } from "vitest";
import { AGENT_CORPUS } from "../agent-corpus";
import { rolefitModel, AGENT_ROLEFIT_MODEL } from "../agent-model-map";

describe("AGENT_CORPUS", () => {
  it("has exactly 45 tasks (3 per agent × 15 agents)", () => {
    expect(AGENT_CORPUS).toHaveLength(45);
  });

  it("covers all 15 agents with exactly 3 tasks each", () => {
    const byAgent = new Map<string, number>();
    for (const t of AGENT_CORPUS) {
      byAgent.set(t.agent_slug, (byAgent.get(t.agent_slug) ?? 0) + 1);
    }
    expect(byAgent.size).toBe(15);
    for (const [slug, count] of byAgent) {
      expect(count, `agent ${slug} should have exactly 3 tasks`).toBe(3);
    }
    expect([...byAgent.keys()].sort()).toEqual(
      Object.keys(AGENT_ROLEFIT_MODEL).sort(),
    );
  });

  it("has unique task_ids in <slug>-<n> form", () => {
    const ids = AGENT_CORPUS.map((t) => t.task_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of AGENT_CORPUS) {
      expect(t.task_id).toBe(`${t.agent_slug}-${t.task_id.split("-").pop()}`);
      expect(t.task_id).toMatch(/^[a-z-]+-\d+$/);
    }
  });

  it("every task has a non-empty system + prompt", () => {
    for (const t of AGENT_CORPUS) {
      expect(t.system.trim().length, `${t.task_id} system`).toBeGreaterThan(10);
      expect(t.prompt.trim().length, `${t.task_id} prompt`).toBeGreaterThan(40);
    }
  });

  it("every task's agent resolves to a role-fit model", () => {
    for (const t of AGENT_CORPUS) {
      expect(rolefitModel(t.agent_slug)).toBeTruthy();
    }
  });
});
