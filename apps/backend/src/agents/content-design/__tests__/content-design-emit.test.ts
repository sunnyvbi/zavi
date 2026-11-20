
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: async () => ["acme/site"],
}));

vi.mock("@/services/supabase", () => {
  const makeChain = (table: string) => {
    const result =
      table === "connector_metadata"
        ? {
            data: {
              repo_full_names: ["acme/site"],
              default_repo_full_name: "acme/site",
              repo_default_branches: { "acme/site": "main" },
            },
            error: null,
          }
        : { data: [], error: null };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      limit: async () => result,
      maybeSingle: async () => result,
    };
    return chain;
  };
  return { serviceClient: () => ({ from: (t: string) => makeChain(t) }) };
});

import { contentSeoPostProcess } from "../post-run";

const rec = (slug: string) => ({
  change_type: "new_page",
  slug,
  title: `Post ${slug}`,
  meta_description: "A useful guide.",
  target_keyword: slug.replace(/-/g, " "),
  body: "## Heading\n\nA complete, in-budget post body that ends cleanly.",
  rationale: "fills a gap",
  expected_impact: "ranks for the term",
});

function makeCtx() {
  const emitted: Array<{ cls: string; body: unknown }> = [];
  return {
    ctx: {
      tenant_id: "tenant-1",
      runId: "run-1",
      emitDecision: async (cls: string, body: unknown) => {
        emitted.push({ cls, body });
        return `decision-${emitted.length}`;
      },
    },
    emitted,
  };
}

describe("contentSeoPostProcess — happy-path emit", () => {
  it("emits one decision per valid rec and drops the malformed one", async () => {
    const { ctx, emitted } = makeCtx();
    const result = {
      parse_ok: true,
      parsed: {
        rendered_markdown: "this week's picks",
        recommendations: [
          rec("how-to-pick-a-crm"),
          { change_type: "new_page", slug: "broken" },
          rec("crm-pricing-guide"),
        ],
      },
      output_text: "this week's picks",
    };
    await contentSeoPostProcess(ctx as never, result as never);
    expect(emitted.length).toBe(2);
    expect(emitted.every((e) => e.cls === "content-design.propose-change")).toBe(true);
    const slugs = emitted.map(
      (e) => (e.body as { files: Array<{ path: string }> }).files[0].path,
    );
    expect(slugs).toEqual([
      "content/blog/how-to-pick-a-crm.md",
      "content/blog/crm-pricing-guide.md",
    ]);
    expect(emitted.every((e) => !("push_to_main" in (e.body as object)))).toBe(true);
  });

  it("emits nothing when there are no recommendations", async () => {
    const { ctx, emitted } = makeCtx();
    await contentSeoPostProcess(
      ctx as never,
      { parse_ok: true, parsed: { rendered_markdown: "nothing this week" }, output_text: "" } as never,
    );
    expect(emitted.length).toBe(0);
  });
});
