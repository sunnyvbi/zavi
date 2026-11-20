import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import {
  loadGlobalAgentDefinition,
  listGlobalAgentSlugs,
  getAgentDefaultState,
} from "@/services/agents/registry";
import { outputSchemas, postProcessors } from "../../index";
import { contentSeoDigestSchema } from "../output-schema";
import {
  parsePublishBlock,
  buildPostFileContent,
  buildPublishProposal,
  recommendationToParsed,
  resolveProvisionedRepoFullName,
  contentSeoPostProcess,
  collectRecommendations,
  collectComponentCopyRecommendations,
  extractFencedJsonRecommendations,
  buildComponentCopyParsed,
  validateComponentPath,
  oldStringLooksLikeCode,
  countOccurrences,
} from "../post-run";
import type { ContentSeoComponentCopyRecommendation } from "../output-schema";
import { prProposalSchema } from "../../engineer/output-schema";
import type { ProvisionedRepoGateDeps } from "@/services/provisioning/provisioned-repo-gate";
import {
  AGENT_SLUG,
  OLD_AGENT_SLUG,
  DECISION_CLASS,
  OLD_DECISION_CLASS,
} from "../constants";

const SLUG = "content-design";
const MIGRATIONS_DIR = path.join(
  __dirname,
  "../../../../../../supabase/migrations",
);

describe("content-design — registers", () => {
  it("is discoverable in the global agent registry", () => {
    expect(listGlobalAgentSlugs()).toContain(SLUG);
  });

  it("loads a valid agent definition from agent.md", () => {
    const def = loadGlobalAgentDefinition(SLUG);
    expect(def).not.toBeNull();
    expect(def!.slug).toBe(SLUG);
    expect(def!.name).toBe(SLUG);
    expect(def!.body_markdown.length).toBeGreaterThan(100);
  });

  it("is ENABLED by default (visible + dispatchable)", () => {
    expect(getAgentDefaultState(SLUG)).toBe("enabled");
  });

  it("declares the propose-change decision class + side_effects in frontmatter", () => {
    const def = loadGlobalAgentDefinition(SLUG)!;
    expect(def.metadata_praxis.side_effects).toBe(true);
    expect(def.metadata_praxis.decision_class).toBe(DECISION_CLASS);
    expect(def.metadata_praxis.output_envelope).toBe("digest");
  });
});

describe("content-design — old content-seo slug alias", () => {
  it("resolves the OLD slug to the canonical content-design definition", () => {
    expect(OLD_AGENT_SLUG).toBe("content-seo");
    const def = loadGlobalAgentDefinition(OLD_AGENT_SLUG);
    expect(def).not.toBeNull();
    expect(def!.slug).toBe(AGENT_SLUG);
  });

  it("reports the OLD slug as enabled too (alias-resolved)", () => {
    expect(getAgentDefaultState(OLD_AGENT_SLUG)).toBe("enabled");
  });
});

describe("content-design — dispatchable", () => {
  it("has its flat digest output schema registered", () => {
    expect(outputSchemas[SLUG]).toBe(contentSeoDigestSchema);
    expect(
      outputSchemas[SLUG].safeParse({ rendered_markdown: "## hi" }).success,
    ).toBe(true);
  });

  it("has its post-processor registered (emits the publish decision)", () => {
    expect(postProcessors[SLUG]).toBe(contentSeoPostProcess);
    expect(typeof postProcessors[SLUG]).toBe("function");
  });
});

function findDecisionClassInsert(classSlug: string): {
  default_autonomy: string;
  dispatch_handler: string;
} | null {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const escaped = classSlug.replace(/[.]/g, "\\.");
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
    if (!sql.includes(classSlug)) continue;
    if (!/insert\s+into\s+decision_classes/i.test(sql)) continue;
    const m = sql.match(
      new RegExp(
        `'${escaped}'\\s*,\\s*'[\\s\\S]*?'\\s*,\\s*'(auto|approval|forbidden)'\\s*,\\s*'([a-z0-9_.]+)'`,
        "i",
      ),
    );
    if (m) return { default_autonomy: m[1], dispatch_handler: m[2] };
  }
  return null;
}

describe("content-design.propose-change — decision class", () => {
  it("is seeded by a migration", () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
    expect(findDecisionClassInsert(DECISION_CLASS)).not.toBeNull();
  });

  it("has default_autonomy 'approval' (never auto-publishes)", () => {
    const row = findDecisionClassInsert(DECISION_CLASS);
    expect(row?.default_autonomy).toBe("approval");
  });

  it("routes through the WIRED github.open_pr handler (engineer pipeline)", () => {
    const row = findDecisionClassInsert(DECISION_CLASS);
    expect(row?.dispatch_handler).toBe("github.open_pr");
  });

  it("never_auto=true is set by the migration (hard approval clamp)", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const found = files.some((f) => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
      return (
        sql.includes(DECISION_CLASS) &&
        /set\s+never_auto\s*=\s*true/i.test(sql)
      );
    });
    expect(found).toBe(true);
  });

  it("keeps the OLD content-seo.publish-content class registered + github.open_pr", () => {
    const row = findDecisionClassInsert(OLD_DECISION_CLASS);
    expect(row).not.toBeNull();
    expect(row?.default_autonomy).toBe("approval");
    expect(row?.dispatch_handler).toBe("github.open_pr");
  });
});

const GOOD_MARKDOWN = `Here is this week's pick.

Publish:
Slug: how-to-choose-a-crm
Title: How to Choose a CRM for a Small Team
Meta-Description: A practical guide to picking the right CRM without overpaying.
Target-Keyword: choose a crm
Body:
## Start with your workflow

Pick the CRM that matches how your team already sells.

## Keep it simple

Avoid feature bloat.
`;

describe("parsePublishBlock", () => {
  it("returns null when there is no Publish block (nothing to ship)", () => {
    expect(parsePublishBlock("Just some prose, no block this week.")).toBeNull();
  });

  it("parses a well-formed block", () => {
    const p = parsePublishBlock(GOOD_MARKDOWN);
    expect(p).not.toBeNull();
    expect("error" in (p as object)).toBe(false);
    const parsed = p as Exclude<typeof p, null | { error: string }>;
    expect(parsed.change_type).toBe("new_blog_post");
    expect(parsed.action).toBe("create");
    expect(parsed.path).toBe("content/blog/how-to-choose-a-crm.md");
    expect(parsed.slug).toBe("how-to-choose-a-crm");
    expect(parsed.title).toBe("How to Choose a CRM for a Small Team");
    expect(parsed.target_keyword).toBe("choose a crm");
    expect(parsed.body).toContain("## Start with your workflow");
    expect(parsed.body).toContain("Avoid feature bloat.");
  });

  it("parses a block wrapped in a code fence", () => {
    const fenced =
      "intro\n\n```\nPublish:\nSlug: x-y\nTitle: T\nMeta-Description: M\nTarget-Keyword: k\nBody:\nhello\n```\nafter";
    const p = parsePublishBlock(fenced);
    const parsed = p as Exclude<typeof p, null | { error: string }>;
    expect(parsed.slug).toBe("x-y");
    expect(parsed.body).toBe("hello");
    expect(parsed.body).not.toContain("after");
  });

  it("rejects a non-kebab / path-traversal slug", () => {
    const bad = GOOD_MARKDOWN.replace(
      "how-to-choose-a-crm",
      "../../etc/passwd",
    );
    const p = parsePublishBlock(bad);
    expect(p).not.toBeNull();
    expect("error" in (p as object)).toBe(true);
  });

  it("rejects a block missing a required field", () => {
    const noTitle = GOOD_MARKDOWN.replace(
      /Title: .*\n/,
      "",
    );
    const p = parsePublishBlock(noTitle);
    expect("error" in (p as object)).toBe(true);
  });
});

describe("buildPostFileContent", () => {
  it("server-writes the front-matter (model body never includes it)", () => {
    const parsed = parsePublishBlock(GOOD_MARKDOWN) as Exclude<
      ReturnType<typeof parsePublishBlock>,
      null | { error: string }
    >;
    const content = buildPostFileContent(parsed);
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain(
      'title: "How to Choose a CRM for a Small Team"',
    );
    expect(content).toContain('keyword: "choose a crm"');
    expect(content).toContain("## Start with your workflow");
  });

  it("escapes a quote in the title so the YAML scalar stays valid", () => {
    const content = buildPostFileContent({
      slug: "s",
      title: 'The "Best" CRM',
      meta_description: "d",
      target_keyword: "k",
      body: "x",
    });
    expect(content).toContain('title: "The \\"Best\\" CRM"');
  });
});

describe("buildPublishProposal", () => {
  it("produces a body that validates against prProposalSchema", () => {
    const parsed = parsePublishBlock(GOOD_MARKDOWN) as Exclude<
      ReturnType<typeof parsePublishBlock>,
      null | { error: string }
    >;
    const proposal = buildPublishProposal(parsed, {
      repo: "praxis-apps/acme-site",
      defaultBranch: "main",
    });
    const res = prProposalSchema.safeParse(proposal);
    expect(res.success).toBe(true);
    expect(proposal.repo).toBe("praxis-apps/acme-site");
    expect(proposal.base_branch).toBe("main");
    expect((proposal.files as Array<{ path: string }>)[0].path).toBe(
      "content/blog/how-to-choose-a-crm.md",
    );
    expect("push_to_main" in proposal).toBe(false);
    expect((proposal.head_branch as string).startsWith("product-builder/")).toBe(
      true,
    );
  });

  it("uses the resolved default branch (not a hardcoded 'main')", () => {
    const parsed = parsePublishBlock(GOOD_MARKDOWN) as Exclude<
      ReturnType<typeof parsePublishBlock>,
      null | { error: string }
    >;
    const proposal = buildPublishProposal(parsed, {
      repo: "acme/site",
      defaultBranch: "develop",
    });
    expect(proposal.base_branch).toBe("develop");
    expect(proposal.head_branch as string).toMatch(
      /^product-builder\/content-design-publish-how-to-choose-a-crm-[0-9a-f]{8}$/,
    );
  });

  it("builds a modify PR proposal for an existing page improvement", () => {
    const parsed = recommendationToParsed({
      change_type: "improve_existing_page",
      path: "content/pages/hosts.mdx",
      title: "Rent Out Your Car With Upcar",
      meta_description: "A clearer host landing page for car owners.",
      target_keyword: "rent out my car",
      body: "---\ntitle: Hosts\n---\n\n# Rent out your car\n\nA complete improved page.",
      rationale: "The host page is the highest-intent conversion surface.",
      expected_impact: "Improves organic host acquisition and signup intent.",
    });
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) throw new Error(parsed.error);

    const proposal = buildPublishProposal(parsed, {
      repo: "upcar/site",
      defaultBranch: "main",
    });

    const res = prProposalSchema.safeParse(proposal);
    expect(res.success).toBe(true);
    expect(proposal.change_type).toBe("improve_existing_page");
    expect((proposal.files as Array<{ path: string; action: string; content: string }>)[0]).toMatchObject({
      path: "content/pages/hosts.mdx",
      action: "modify",
    });
    expect((proposal.files as Array<{ content: string }>)[0].content).toContain(
      "# Rent out your car",
    );
    expect(proposal.body as string).toContain("Updates existing page improvement");
    expect(proposal.body as string).toContain("File: `content/pages/hosts.mdx`");
  });
});

describe("component_copy mechanism", () => {
  const FILE = [
    'import React from "react";',
    "",
    "export function EmptyState() {",
    '  return <div className="empty">No data yet</div>;',
    "}",
    "",
  ].join("\n");

  function rec(
    over: Partial<ContentSeoComponentCopyRecommendation> = {},
  ): ContentSeoComponentCopyRecommendation {
    return {
      change_type: "component_copy",
      path: "src/components/EmptyState.tsx",
      edits: [{ old_string: "No data yet", new_string: "Connect a source to see your first report" }],
      user_need: "A new user does not know what to do on the empty dashboard.",
      evidence: [{ source: "product__probe", detail: "Empty state has no next step." }],
      content_decision: "add_microcopy",
      ...over,
    };
  }

  it("applies an exact-once match and produces the WHOLE updated file", () => {
    const out = buildComponentCopyParsed(rec(), FILE);
    expect("error" in out).toBe(false);
    if ("error" in out) throw new Error(out.error);
    expect(out.parsed.change_type).toBe("component_copy");
    expect(out.parsed.action).toBe("modify");
    expect(out.parsed.path).toBe("src/components/EmptyState.tsx");
    expect(out.parsed.body).toContain("Connect a source to see your first report");
    expect(out.parsed.body).not.toContain("No data yet");
    expect(out.parsed.body).toContain('import React from "react";');
    expect(out.parsed.user_need).toContain("empty dashboard");
    expect(out.parsed.content_decision).toBe("add_microcopy");
  });

  it("drops the rec when old_string is NOT found (0 matches)", () => {
    const out = buildComponentCopyParsed(
      rec({ edits: [{ old_string: "This text is not in the file", new_string: "x" }] }),
      FILE,
    );
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toMatch(/not uniquely found \(0 matches\).*needs engineer/);
  });

  it("drops the rec when old_string occurs more than once (2 matches)", () => {
    const dup = "Save\nSave";
    const out = buildComponentCopyParsed(
      rec({ edits: [{ old_string: "Save", new_string: "Save changes" }] }),
      dup,
    );
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toMatch(/not uniquely found \(2 matches\)/);
  });

  it("drops a denylisted (money/auth/PII-adjacent) path before any read", () => {
    const out = buildComponentCopyParsed(
      rec({ path: "src/components/billing/PriceLabel.tsx" }),
      FILE,
    );
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toMatch(/denylisted/);
    expect(validateComponentPath("src/payment/Checkout.tsx")).toMatchObject({
      error: expect.stringMatching(/denylisted/),
    });
    expect(validateComponentPath("src/auth/SessionBanner.tsx")).toMatchObject({
      error: expect.stringMatching(/denylisted/),
    });
  });

  it("rejects an old_string that looks like CODE, not copy", () => {
    expect(oldStringLooksLikeCode("const x = 1")).toBe(true);
    expect(oldStringLooksLikeCode("import foo from 'bar'")).toBe(true);
    expect(oldStringLooksLikeCode("onClick={() => doThing()}")).toBe(true);
    expect(oldStringLooksLikeCode("<Button disabled>")).toBe(true);
    expect(oldStringLooksLikeCode("`Hello ${name}`")).toBe(true);
    expect(oldStringLooksLikeCode("No data yet")).toBe(false);
    expect(oldStringLooksLikeCode("Save changes")).toBe(false);

    const out = buildComponentCopyParsed(
      rec({ edits: [{ old_string: "const empty = true", new_string: "const empty = false" }] }),
      'const empty = true;\n',
    );
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toMatch(/looks like code/);
  });

  it("rejects a non-component path (must end in .ts/.tsx/.js/.jsx)", () => {
    expect(validateComponentPath("content/pages/hosts.mdx")).toMatchObject({
      error: expect.stringMatching(/\.ts\/\.tsx\/\.js\/\.jsx/),
    });
    expect(validateComponentPath("/etc/passwd")).toHaveProperty("error");
    expect(validateComponentPath("../secrets.ts")).toHaveProperty("error");
  });

  it("countOccurrences counts non-overlapping literal matches", () => {
    expect(countOccurrences("a b a b a", "a")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("nothing", "zzz")).toBe(0);
  });

  it("builds a valid modify PR proposal with a content-design card (no SEO keyword framing)", () => {
    const out = buildComponentCopyParsed(rec({ success_signal: "Lower first-session drop-off." }), FILE);
    if ("error" in out) throw new Error(out.error);
    const proposal = buildPublishProposal(out.parsed, {
      repo: "acme/app",
      defaultBranch: "main",
    });
    const res = prProposalSchema.safeParse(proposal);
    expect(res.success).toBe(true);
    const file = (proposal.files as Array<{ path: string; action: string; content: string }>)[0];
    expect(file.action).toBe("modify");
    expect(file.path).toBe("src/components/EmptyState.tsx");
    expect(file.content).toContain("Connect a source to see your first report");
    const card = proposal.rendered_markdown as string;
    expect(card).toContain("in-product copy change");
    expect(card).toContain("User need:");
    expect(card).toContain("Content decision:");
    expect(card).toContain("Evidence:");
    expect(card).toContain("Success signal:");
    expect(card).not.toMatch(/targeting \*\*/);
    expect("push_to_main" in proposal).toBe(false);
  });

  it("collectComponentCopyRecommendations extracts only component_copy recs from structured output", () => {
    const componentRec = rec();
    const markdownRec = {
      change_type: "new_blog_post" as const,
      slug: "a-post",
      title: "A Post",
      body: "## Body\n\nDone.",
    };
    const got = collectComponentCopyRecommendations({
      parsed: { rendered_markdown: "x", recommendations: [componentRec, markdownRec] },
    } as never);
    expect(got).toHaveLength(1);
    expect(got[0].change_type).toBe("component_copy");
  });

  it("rejects an edit whose new_string looks like CODE, not copy", () => {
    const out = buildComponentCopyParsed(
      rec({
        edits: [
          {
            old_string: "No data yet",
            new_string: "<script>alert(1)</script>",
          },
        ],
      }),
      FILE,
    );
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toMatch(/new_string looks like code/);
  });

  it("allows an EMPTY new_string (pure deletion of copy is valid)", () => {
    const out = buildComponentCopyParsed(
      rec({ edits: [{ old_string: "No data yet", new_string: "" }] }),
      FILE,
    );
    expect("error" in out).toBe(false);
    if ("error" in out) throw new Error(out.error);
    expect(out.parsed.body).not.toContain("No data yet");
    expect(out.parsed.body).toContain('<div className="empty"></div>');
  });

  it("rejects two edits whose spans overlap in the original file", () => {
    const FILE2 = "alpha beta gamma\n";
    const out = buildComponentCopyParsed(
      rec({
        edits: [
          { old_string: "alpha beta", new_string: "ALPHA BETA" },
          { old_string: "beta gamma", new_string: "BETA GAMMA" },
        ],
      }),
      FILE2,
    );
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toMatch(/overlap/);
  });

  it("multi-edit apply is order-independent and does not cascade", () => {
    const FILE3 = "one two\n";
    const editsForward = [
      { old_string: "one", new_string: "two" },
      { old_string: "two", new_string: "three" },
    ];
    const outForward = buildComponentCopyParsed(
      rec({ edits: editsForward }),
      FILE3,
    );
    if ("error" in outForward) throw new Error(outForward.error);
    expect(outForward.parsed.body).toBe("two three\n");

    const outReversed = buildComponentCopyParsed(
      rec({ edits: [...editsForward].reverse() }),
      FILE3,
    );
    if ("error" in outReversed) throw new Error(outReversed.error);
    expect(outReversed.parsed.body).toBe(outForward.parsed.body);
  });

  it("does not let an earlier edit's new_string satisfy a later edit's exact-once check", () => {
    const FILE4 = "hello\n";
    const out = buildComponentCopyParsed(
      rec({
        edits: [
          { old_string: "hello", new_string: "world" },
          { old_string: "world", new_string: "earth" },
        ],
      }),
      FILE4,
    );
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error).toMatch(/old_string not uniquely found \(0 matches\)/);
    }
  });
});

describe("recommendation recovery", () => {
  const rec = {
    change_type: "new_page" as const,
    slug: "peer-to-peer-car-rental-insurance",
    title: "Peer-to-Peer Car Rental Insurance: What Hosts Need to Know",
    meta_description: "A practical guide to peer-to-peer rental insurance for hosts.",
    target_keyword: "peer-to-peer car rental insurance",
    body: "## Start with coverage\n\nA complete draft that ends cleanly.",
    rationale: "Insurance is a high-intent host onboarding objection.",
    expected_impact: "Captures host searches near listing intent.",
  };

  it("extracts fenced JSON recommendations from rendered markdown", () => {
    const markdown = `Research summary.\n\n\`\`\`json\n${JSON.stringify({ recommendations: [rec] })}\n\`\`\`\n`;
    const recovered = extractFencedJsonRecommendations(markdown);
    expect(recovered).toHaveLength(1);
    expect("slug" in recovered[0] ? recovered[0].slug : null).toBe(
      "peer-to-peer-car-rental-insurance",
    );
  });

  it("collects fenced recommendations before falling back to legacy Publish blocks", () => {
    const markdown = `Queued draft.\n\n\`\`\`json\n${JSON.stringify({ recommendations: [rec] })}\n\`\`\`\n`;
    const out = collectRecommendations({
      parse_ok: true,
      parsed: { rendered_markdown: markdown },
      output_text: markdown,
    } as never);
    expect(out.parseError).toBeUndefined();
    expect(out.recs).toHaveLength(1);
    expect(out.recs[0]).toMatchObject({
      slug: "peer-to-peer-car-rental-insurance",
      target_keyword: "peer-to-peer car rental insurance",
    });
  });
});

describe("resolveProvisionedRepoFullName", () => {
  const provisioned: ProvisionedRepoGateDeps = {
    async loadRepoResource() {
      return {
        mode: "provisioned",
        external_ref: { github_full_name: "praxis-apps/acme-site" },
      };
    },
  };
  const connected: ProvisionedRepoGateDeps = {
    async loadRepoResource() {
      return {
        mode: "connected",
        external_ref: { github_full_name: "customer/their-repo" },
      };
    },
  };
  const none: ProvisionedRepoGateDeps = {
    async loadRepoResource() {
      return null;
    },
  };
  const throws: ProvisionedRepoGateDeps = {
    async loadRepoResource() {
      throw new Error("db down");
    },
  };

  it("returns the full name for a provisioned repo", async () => {
    expect(await resolveProvisionedRepoFullName("t1", provisioned)).toBe(
      "praxis-apps/acme-site",
    );
  });

  it("returns null for a CONNECTED (customer-owned) repo — wrong publish surface", async () => {
    expect(await resolveProvisionedRepoFullName("t1", connected)).toBeNull();
  });

  it("returns null when the tenant has no repo row", async () => {
    expect(await resolveProvisionedRepoFullName("t1", none)).toBeNull();
  });

  it("fails closed (null) on a read error", async () => {
    expect(await resolveProvisionedRepoFullName("t1", throws)).toBeNull();
  });
});

type FakeCtx = {
  tenant_id: string;
  runId: string;
  emitDecision: (cls: string, body: unknown) => Promise<string>;
  emitted: Array<{ cls: string; body: unknown }>;
};

function makeCtx(): FakeCtx {
  const emitted: Array<{ cls: string; body: unknown }> = [];
  return {
    tenant_id: "tenant-1",
    runId: "run-1",
    emitted,
    async emitDecision(cls, body) {
      emitted.push({ cls, body });
      return "decision-123";
    },
  };
}

describe("contentSeoPostProcess", () => {
  it("does NOT emit when there is no Publish block", async () => {
    const ctx = makeCtx();
    const result = {
      parse_ok: true,
      parsed: { rendered_markdown: "nothing this week" },
      output_text: "nothing this week",
    } as never;
    await contentSeoPostProcess(ctx as never, result);
    expect(ctx.emitted.length).toBe(0);
  });

  it("does NOT emit when the run failed to parse", async () => {
    const ctx = makeCtx();
    const result = { parse_ok: false, parsed: null, output_text: "" } as never;
    await contentSeoPostProcess(ctx as never, result);
    expect(ctx.emitted.length).toBe(0);
  });
});
