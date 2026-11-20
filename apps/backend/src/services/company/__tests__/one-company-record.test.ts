import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..", "..", "..", "..");

const PATTERN = [
  "tenant_fact",
  "company_profiles",
  "company_profile_fields",
  "competitor_profiles",
  "competitor_intel_custom_brands",
  "set_tenant_company_domain",
  "set_tenant_product_url",
  "project_tenant_fact",
  "set_tenant_fact",
  String.raw`memory\.company`,
  String.raw`slug: ?"company"`,
  String.raw`slug: ?'company'`,
  "upsertAnchor",
  "regenerateAnchor",
  "reddit_competitors",
  String.raw`from\(["'][a-z][a-z0-9_]*_competitors["']\)`,
].join("|");

const ROOTS = [
  "apps/backend/src",
  "apps/backend/workers",
  "apps/web/src",
  "apps/admin/src",
  "apps/mobile/src",
  "packages/shared/src",
];

const REGISTRY: Record<string, string> = {
  "apps/backend/src/routes/admin/admin-tasks.ts": "anchor-writer-unguarded",
  "apps/backend/src/routes/memory/regenerate-anchor.ts": "anchor-writer-company-derived",
  "apps/backend/src/routes/onboarding/gap-answer.ts": "anchor-writer-unguarded",
  "apps/backend/src/services/agents/deepagent/backends/zavi-memory-backend.ts": "anchor-writer-other-slugs",
  "apps/backend/src/services/agents/deepagent/studio/local-funnel.ts": "anchor-writer-other-slugs",
  "apps/backend/src/services/growth/apply-strategy.ts": "anchor-writer-other-slugs",
  "apps/backend/src/services/memory/contextualize.ts": "anchor-writer",
  "apps/backend/src/services/memory/fill-placeholder-docs.ts": "anchor-writer-other-slugs",
  "apps/backend/src/services/memory/generate-anchors.ts": "anchor-writer-company-derived",
  "apps/backend/src/services/onboarding/background-memory.ts": "anchor-writer-other-slugs",
  "apps/backend/src/services/onboarding/website-memory-job.ts": "anchor-writer-other-slugs",
  "apps/backend/src/services/memory/index.ts": "anchor-writer",
  "apps/backend/src/services/memory/upsert-anchor.ts": "anchor-writer",
  "apps/backend/src/services/readiness/promote-draft.ts": "anchor-writer-company-derived",
  "apps/backend/src/services/tools/discovery/write-anchor.ts": "anchor-writer-drafts-only",
  "apps/backend/src/services/tools/memory/_anchor-pending.ts": "anchor-writer-unguarded",
  "apps/backend/src/services/tools/memory/apply-anchor.ts": "anchor-writer-unguarded",
  "apps/backend/workers/functions/auto-provision-tenant.ts": "anchor-writer-unguarded",
  "apps/backend/workers/functions/bootstrap-anchors.ts": "anchor-writer-unguarded",
  "apps/backend/src/routes/workspace/growth-intake-research.ts": "reader",
  "apps/web/src/components/workspace/GrowthInterview.tsx": "domain-writer-via-route",
  "apps/backend/src/services/sites/primary-site-website.ts": "domain-writer-system-rpc",
  "apps/web/src/components/workspace/BrainTab.tsx": "reader",
  "apps/web/src/components/workspace/home/CompanyBriefCard.tsx": "reader",
  "apps/admin/src/app/(dashboard)/tenants/[id]/page.tsx": "staff-research",
  "apps/backend/src/agents/advisor/agent.md": "prompt-narrative",
  "apps/backend/src/agents/advisor/output-schema.ts": "reader",
  "apps/backend/src/agents/blog/agent.md": "prompt-narrative",
  "apps/backend/src/agents/browser-operator/agent.md": "prompt-narrative",
  "apps/backend/src/agents/cgo/agent.md": "prompt-narrative",
  "apps/backend/src/services/eval/growth-sim/decision-replay.ts": "reader",
  "apps/backend/src/agents/chief-of-staff/agent.md": "prompt-narrative",
  "apps/backend/src/agents/chatgpt_ads/agent.md": "prompt-narrative",
  "apps/backend/src/agents/content-design/agent.md": "prompt-narrative",
  "apps/backend/src/agents/dispute-response/agent.md": "prompt-narrative",
  "apps/backend/src/agents/email_marketing/agent.md": "prompt-narrative",
  "apps/backend/src/agents/engineer/agent.md": "prompt-narrative",
  "apps/backend/src/agents/engineer/post-run.ts": "reader",
  "apps/backend/src/agents/fundraising/agent.md": "prompt-narrative",
  "apps/backend/src/agents/generated_video/agent.md": "prompt-narrative",
  "apps/backend/src/agents/google_ads/agent.md": "prompt-narrative",
  "apps/backend/src/agents/growth-lead/agent.md": "prompt-narrative",
  "apps/backend/src/agents/instagram_organic/agent.md": "prompt-narrative",
  "apps/backend/src/agents/linkedin_ads/agent.md": "prompt-narrative",
  "apps/backend/src/agents/linkedin_organic/agent.md": "prompt-narrative",
  "apps/backend/src/agents/meta_ads/agent.md": "prompt-narrative",
  "apps/backend/src/agents/x_ads/agent.md": "prompt-narrative",
  "apps/backend/src/agents/operator/agent.md": "prompt-narrative",
  "apps/backend/src/agents/performance-marketer/agent.md": "prompt-narrative",
  "apps/backend/src/agents/pm/agent.md": "prompt-narrative",
  "apps/backend/src/agents/pm/post-run.ts": "reader",
  "apps/backend/src/agents/qa/agent.md": "prompt-narrative",
  "apps/backend/src/agents/reddit_ads/agent.md": "prompt-narrative",
  "apps/backend/src/agents/reddit_organic/agent.md": "prompt-narrative",
  "apps/backend/src/agents/pinterest_organic/agent.md": "prompt-narrative",
  "apps/backend/src/agents/research/agent.md": "prompt-narrative",
  "apps/backend/src/agents/seo-geo/agent.md": "prompt-narrative",
  "apps/backend/src/agents/seo/agent.md": "prompt-narrative",
  "apps/backend/src/agents/geo/agent.md": "prompt-narrative",
  "apps/backend/src/agents/sms/agent.md": "prompt-narrative",
  "apps/backend/src/agents/supply-demand-balancer/agent.md": "prompt-narrative",
  "apps/backend/src/agents/support-lead/agent.md": "prompt-narrative",
  "apps/backend/src/agents/tiktok_ads/agent.md": "prompt-narrative",
  "apps/backend/src/agents/tiktok_organic/agent.md": "prompt-narrative",
  "apps/backend/src/agents/ugc/agent.md": "prompt-narrative",
  "apps/backend/src/agents/x_organic/agent.md": "prompt-narrative",
  "apps/backend/src/agents/youtube_ads/agent.md": "prompt-narrative",
  "apps/backend/src/agents/youtube_organic/agent.md": "prompt-narrative",
  "apps/backend/src/channels/instagram_organic/recipe.md": "reader",
  "apps/backend/src/channels/linkedin_organic/recipe.md": "reader",
  "apps/backend/src/channels/reddit_organic/recipe.md": "reader",
  "apps/backend/src/routes/admin/company-facts-suggest.ts": "staff-research",
  "apps/backend/src/routes/admin/company-facts.ts": "staff-research",
  "apps/backend/src/routes/admin/company-fields.ts": "staff-research",
  "apps/backend/src/routes/admin/company-profiles.ts": "staff-research",
  "apps/backend/src/routes/admin/competitor-profiles.ts": "staff-research",
  "apps/backend/src/routes/competitor-intel/index.ts": "competitors",
  "apps/backend/src/routes/reddit/workspace.ts": "channel-record-writer",
  "apps/backend/src/services/channels/reddit/workspace.ts": "channel-record-writer",
  "apps/backend/src/services/channels/reddit/db.ts": "channel-local-competitors",
  "apps/backend/src/services/channels/reddit/suggest.ts": "channel-local-competitors",
  "apps/backend/src/services/channels/reddit/sweep.ts": "channel-local-competitors",
  "apps/backend/src/routes/channels/settings.ts": "names-the-old-table-in-prose",
  "apps/web/src/components/workspace/actions/platforms/reddit_organic.ts":
    "names-the-old-table-in-prose",
  "apps/backend/src/routes/connectors/tenant-company-facts.ts": "facts-surface",
  "apps/backend/src/routes/connectors/tenant-product-url.ts": "reader",
  "apps/backend/src/routes/onboarding/activate.ts": "onboarding-writer",
  "apps/backend/src/routes/public/launch-video-claim.ts": "launch-video-claim-writer",
  "apps/backend/src/services/agents/build-credit-preflight.ts": "reader",
  "apps/backend/src/services/agents/company-fact-sheet.ts": "facts-surface",
  "apps/backend/src/services/agents/generic-dispatcher.ts": "reader",
  "apps/backend/src/services/agents/prompt-injection.ts": "reader",
  "apps/backend/src/services/agents/runner.ts": "reader",
  "apps/backend/src/services/channels/due.ts": "reader",
  "apps/backend/src/services/client-context/sections.ts": "reader",
  "apps/backend/src/services/company-facts/write.ts": "facts-surface",
  "apps/backend/src/services/company/facts.ts": "module",
  "apps/backend/src/services/company/brief.ts": "module-render",
  "apps/backend/src/services/company/suggestions.ts": "module-suggest",
  "apps/backend/src/services/company/country-inference.ts": "module-infer",
  "apps/backend/src/services/competitor-intel/frame.ts": "competitors",
  "apps/backend/src/services/competitor-intel/scan.ts": "competitors",
  "apps/backend/src/services/knowledge-import/save-facts.ts": "facts-surface",
  "apps/backend/src/services/setup/chat-fastpaths.ts": "facts-surface",
  "apps/backend/src/services/mcp/internal/product.ts": "reader",
  "apps/backend/src/services/memory/brain-slots.ts": "reader",
  "apps/backend/src/services/memory/loader.ts": "reader",
  "apps/backend/src/services/personalization/store.ts": "reader",
  "apps/backend/src/services/personalization/summary.ts": "reader",
  "apps/backend/src/services/readiness/fold-distill.ts": "reader",
  "apps/backend/src/services/settings/registry.ts": "reader",
  "apps/backend/src/services/company/description-draft.ts": "reader",
  "apps/backend/src/services/tenant-client.ts": "reader",
  "apps/backend/src/services/tenants/new-tenant-alert.ts": "reader",
  "apps/backend/src/services/tools/growth/seo/run.ts": "reader",
  "apps/backend/src/services/tools/growth/seo/snapshot.ts": "reader",
  "apps/backend/workers/client.ts": "reader",
  "apps/backend/workers/functions/channel-sweep.ts": "reader",
  "apps/backend/workers/functions/fde-fold-scan.ts": "reader",
  "apps/backend/workers/functions/plan-critic.ts": "reader",
  "apps/backend/workers/functions/provisioning-deploy-poll.ts": "reader",
};

function touchingFiles(): string[] {
  let out = "";
  try {
    out = execFileSync("grep", ["-rlE", PATTERN, ...ROOTS], {
      cwd: REPO,
      encoding: "utf8",
    });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !f.includes("__tests__") && !f.includes(".test."));
}

describe("one company record", () => {
  it("has no company-data surface outside the reviewed registry", () => {
    const unregistered = touchingFiles().filter((f) => !(f in REGISTRY));
    expect(
      unregistered,
      `New file(s) touching company identity. Route company facts through ` +
        `services/company/facts.ts, then classify the file in this registry:\n` +
        unregistered.map((f) => `  "${f}": "reader",`).join("\n"),
    ).toEqual([]);
  });

  it("still finds the surfaces it is meant to guard", () => {
    const found = touchingFiles();
    expect(found.length).toBeGreaterThan(50);
    expect(found).toContain("apps/backend/src/services/company/facts.ts");
  });

  it("keeps exactly one module classified as the record itself", () => {
    const modules = Object.entries(REGISTRY).filter(([, d]) => d === "module");
    expect(modules.map(([f]) => f)).toEqual([
      "apps/backend/src/services/company/facts.ts",
    ]);
  });
});
