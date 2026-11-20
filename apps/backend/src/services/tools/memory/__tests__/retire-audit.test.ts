
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auditCalls: [] as Array<Record<string, unknown>>,
  candidates: [
    { id: "n-1", title: "Berlin HQ", body_markdown: "We are HQ'd in Berlin", source: "auto_distill", note_type: "tenant_reference" },
  ],
  modelText: "[0]",
}));

function makeClient() {
  return {
    from() {
      const state = { didUpdate: false };
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = vi.fn(chain);
      b.eq = vi.fn(chain);
      b.is = vi.fn(chain);
      b.not = vi.fn(chain);
      b.order = vi.fn(chain);
      b.limit = vi.fn(chain);
      b.update = vi.fn(() => {
        state.didUpdate = true;
        return b;
      });
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
        if (state.didUpdate) return resolve({ error: null });
        return resolve({ data: h.candidates, error: null });
      };
      return b;
    },
  };
}

vi.mock("@/services/supabase", () => ({ serviceClient: () => makeClient() }));
vi.mock("@/services/llm/call-model", () => ({
  callModel: async () => ({ text: h.modelText }),
}));
vi.mock("@/services/llm/models", () => ({
  DEFAULT_PROVIDER: "anthropic",
  MODELS: { anthropic: { haiku: "claude-haiku" } },
}));
vi.mock("@/services/memory/mutation-audit", () => ({
  writeMutationAudit: async (p: Record<string, unknown>) => {
    h.auditCalls.push(p);
  },
  buildRetireSnapshot: (note: { id: string }, agent_slug?: string | null) => ({
    redaction: "retire_ref",
    note_id: note.id,
    agent_slug: agent_slug ?? null,
  }),
}));

import { retireNotesByDescription } from "../_anchor-pending";

beforeEach(() => {
  h.auditCalls.length = 0;
});

describe("retireNotesByDescription audit", () => {
  it("writes a retire audit row with the agent_slug threaded + tenant-scoped", async () => {
    const out = await retireNotesByDescription("tenant-Z", "the false Berlin HQ claim", {
      agent_slug: "chief-of-staff",
    });
    expect(out.retired).toBe(1);

    expect(h.auditCalls).toHaveLength(1);
    const call = h.auditCalls[0];
    expect(call.action).toBe("retire");
    expect(call.tenant_id).toBe("tenant-Z");
    expect(call.note_id).toBe("n-1");
    expect(call.actor_user_id ?? null).toBeNull();
    expect((call.before_snapshot as Record<string, unknown>).agent_slug).toBe("chief-of-staff");
  });
});
