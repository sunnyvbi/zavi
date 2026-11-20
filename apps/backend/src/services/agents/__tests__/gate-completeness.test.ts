
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import {
  registerCompletenessGate,
  getRegisteredGates,
  resetCompletenessGates,
  evaluateGate,
  enumerateLiveAgentSlugs,
  enumerateAgentsWithCapability,
  extractSetMembers,
  TOOL_TOKEN_RE,
  type CompletenessGate,
} from "../gate-completeness";

const AGENTS_ROOT = join(__dirname, "..", "..", "..", "agents");
const SERVICES_AGENTS = join(__dirname, "..");

function liveSlugs(): string[] {
  return enumerateLiveAgentSlugs(AGENTS_ROOT);
}

function memberClassifier(file: string, constName: string) {
  const members = extractSetMembers(join(SERVICES_AGENTS, file), constName);
  if (members.size === 0) {
    throw new Error(
      `gate-completeness: parsed 0 members for ${constName} in ${file} — parser or set shape changed.`,
    );
  }
  return (slug: string): "in-set" | "reasoned-exclude" =>
    members.has(slug) ? "in-set" : "reasoned-exclude";
}

function capabilityMemberClassifier(
  file: string,
  constName: string,
  flag: "money_path" | "reads_operator_db",
  deriveExclude: ReadonlySet<string> = new Set(),
) {
  const members = extractSetMembers(join(SERVICES_AGENTS, file), constName);
  if (members.size === 0) {
    throw new Error(
      `gate-completeness: parsed 0 members for ${constName} in ${file} — parser or set shape changed.`,
    );
  }
  const capMembers = enumerateAgentsWithCapability(AGENTS_ROOT, flag);
  return (slug: string): "in-set" | "reasoned-exclude" => {
    if (members.has(slug)) return "in-set";
    if (capMembers.has(slug) && !deriveExclude.has(slug)) return "in-set";
    return "reasoned-exclude";
  };
}

const PII_SCRUB_DERIVE_EXCLUDE = new Set(["operator", "advisor"]);

const MONEY_PATH_EXCLUSIONS: Record<string, string> = {
  "email_marketing": "owned channel — its two producers emit approval-gated decisions and neither sends; email_send is deliberately NOT granted (capabilities.money_path:false)",
  "sms": "owned channel — no messaging connector and no sms__* tool exists, so it cannot send, let alone spend (capabilities.money_path:false)",
  "linkedin_organic": "organic channel — no spend lever exists on it at all",
  "reddit_organic": "organic channel — no spend lever exists on it at all",
  "blog": "organic channel — writes posts the founder publishes; no spend lever exists on it at all",
  "pinterest_organic": "organic channel — no spend lever exists on it at all",
  "instagram_organic": "organic channel — no spend lever exists on it at all",
  "x_organic": "organic channel — stages posts behind the social.publish.v2 approval gate; X bills Zavi's own app, not the tenant, and it holds no spend tool",
  "tiktok_organic": "organic channel — no connector, no spend lever",
  "youtube_organic": "organic channel — no spend lever; the write path is a human-approved upload, not a purchase",
  "seo-geo": "read-only SEO/GEO audit — no Stripe or ad-spend money move",
  seo: "organic channel — crawls the operator's own public site, holds no spend or Stripe tool (capabilities.money_path:false)",
  geo: "organic channel (split off seo 2026-09-16) — reads the operator's own public site and web search, holds no spend or Stripe tool (capabilities.money_path:false)",
  generated_video:
    "organic channel — its run writes approvable script cards and spends nothing; the render that spends media credits runs only in the channel-action worker after a human Approve, never inside the agent run, so an agent retry cannot re-spend (capabilities.money_path:false)",
  advisor: "read/advisory only — no irreversible external money action",
  "browser-operator": "drives a browser session — no Stripe/ad-spend money move",
  "chief-of-staff": "synthesis/routing only — no money action",
  "content-design": "copy/design output — no money action",
  engineer: "ships code/PRs — no external money movement",
  fundraising: "drafts/advisory — never moves money",
  "growth-lead": "planning/ideation — no irreversible spend",
  "onboarding-discovery": "onboarding enrichment — no money action",
  operator: "conversational front-door + reads — no irreversible money action",
  pm: "product strategy — no money action",
  qa: "prose QA — no money action",
  research: "read-only research — no money action",
  "supply-demand-balancer": "marketplace-balancing analysis — no money move",
  "support-lead":
    "routes chargebacks to dispute-response but never itself submits money",
};

const ARTIFACT_EXCLUSIONS: Record<string, string> = {
  cgo: "the strategy renders as markdown in the reply — no render tool is granted and post-run.ts writes no run_artifacts row, so there is no stale artifact for the fresh-work gate to drop",
  advisor: "conversational advice — no deliverable artifact",
  "browser-operator": "browser automation — no report/PDF deliverable",
  "chief-of-staff": "synthesis/routing — no customer-facing artifact",
  engineer: "ships PRs, not a fresh-work report/PDF deliverable",
  fundraising: "drafts — no operator fresh-work artifact",
  "onboarding-discovery": "onboarding enrichment — no artifact",
  operator: "the front-door itself — not a producer of a downstream artifact",
  qa: "prose QA — no deliverable artifact",
  "supply-demand-balancer": "analysis output — no report/PDF deliverable",
  "support-lead": "triage/routing — no customer-facing deliverable artifact",
};

const PII_SCRUB_EXCLUSIONS: Record<string, string> = {
  "instagram_organic": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "linkedin_organic": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "meta_ads": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "reddit_ads": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "chatgpt_ads": "channel capsule — reads the company's own public surfaces, OpenAI's public policy pages and an operator-pasted snapshot; no operator_db read, so no customer PII in egress",
  "reddit_organic": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "blog": "channel capsule — reads the company's own site, public search results and its own Search Console; no operator_db read, so no customer PII in egress",
  "pinterest_organic": "channel capsule — reads public Pinterest and the company's own site; no operator_db read, so no customer PII in egress",
  "tiktok_ads": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "tiktok_organic": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "ugc": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "x_organic": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "x_ads": "channel capsule — reads the company's own public surfaces and its own X Ads account; no operator_db read, so no customer PII in egress",
  "youtube_organic": "channel capsule — reads the company's own public surfaces and its own ad/analytics accounts; no operator_db read, so no customer PII in egress",
  "youtube_ads": "channel capsule — reads public surfaces and the company's own Google Ads account; no operator_db read, so no customer PII in egress",
  "linkedin_ads": "channel capsule — reads public surfaces only; no operator_db read, so no customer PII in egress",
  "sms": "channel capsule — reads public pages and DNS only; it cannot read a messaging account, so no customer PII reaches egress",
  "seo-geo": "holds no operator_db tool — reads public web pages, never customer rows",
  seo: "holds no operator_db tool — crawls the operator's own public site and the SERP, never customer rows",
  geo: "holds no operator_db tool — reads the operator's own public site, robots.txt and web search, never customer rows",
  generated_video:
    "holds no operator_db tool — reads the operator's own public surfaces and the SERP, never customer rows",
  advisor:
    "explicit code decision — conversational front-door; operator_db reads already PII-redacted at the read layer",
  operator:
    "explicit code decision — conversational front-door; operator_db reads already PII-redacted at the read layer",
  "browser-operator": "browser automation — does not echo tenant contact PII",
  "content-design": "copy/design — no tenant contact PII in output",
  engineer: "code/PR output — no tenant contact PII egress",
  fundraising: "fundraise drafts — no tenant contact PII egress",
  "onboarding-discovery": "onboarding enrichment — no PII egress surface",
  qa: "prose QA — no tenant contact PII in output",
  google_ads: "holds no operator_db tool — reads the Google Ads API and public web, never customer rows",
  research: "external research — no tenant contact PII egress",
  "supply-demand-balancer": "aggregate balancing analysis — no contact PII",
};

const STRUCTURED_RESCUE_EXCLUSIONS: Record<string, string> = {
  "instagram_organic": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "linkedin_organic": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "meta_ads": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "reddit_ads": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "chatgpt_ads": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "reddit_organic": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "blog": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "pinterest_organic": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "tiktok_ads": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "tiktok_organic": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "ugc": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "x_organic": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "x_ads": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "youtube_organic": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "youtube_ads": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "linkedin_ads": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "email_marketing": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "sms": "emits a ChannelStep[] envelope — schema not verified for clarifying-question fields",
  "seo-geo": "envelope schema not verified for clarifying-question fields",
  advisor: "envelope schema not verified for clarifying-question fields",
  "browser-operator": "envelope schema not verified for clarifying-question fields",
  "chief-of-staff": "envelope schema not verified for clarifying-question fields",
  "content-design": "envelope schema not verified for clarifying-question fields",
  "dispute-response": "envelope schema not verified for clarifying-question fields",
  fundraising: "envelope schema not verified for clarifying-question fields",
  google_ads: "envelope schema not verified for clarifying-question fields",
  "growth-lead": "envelope schema not verified for clarifying-question fields",
  "onboarding-discovery": "envelope schema not verified for clarifying-question fields",
  operator: "envelope schema not verified for clarifying-question fields",
  "performance-marketer": "envelope schema not verified for clarifying-question fields",
  qa: "envelope schema not verified for clarifying-question fields",
  research: "envelope schema not verified for clarifying-question fields",
  seo: "envelope schema not verified for clarifying-question fields",
  geo: "envelope schema not verified for clarifying-question fields (same channel envelope as seo)",
  generated_video: "envelope schema not verified for clarifying-question fields",
  "supply-demand-balancer": "envelope schema not verified for clarifying-question fields",
  "support-lead": "envelope schema not verified for clarifying-question fields",
};

const AGENTS_ROOT_ABS = AGENTS_ROOT;

function toolSetGate(name: string, filePath: string, constName: string): CompletenessGate {
  const members = [...extractSetMembers(filePath, constName, TOOL_TOKEN_RE)];
  if (members.length === 0) {
    throw new Error(
      `gate-completeness: parsed 0 members for ${constName} in ${filePath} — parser or set shape changed.`,
    );
  }
  return {
    name,
    enumerateSubjects: () => members,
    classify: () => "in-set",
  };
}

const REVENUE_TOOLS_FILE = join(AGENTS_ROOT_ABS, "chief-of-staff", "gmv-guard.ts");
const FETCH_SERVERS_FILE = join(AGENTS_ROOT_ABS, "research", "claim-grounding.ts");
const OPERATOR_POLICY_FILE = join(SERVICES_AGENTS, "operator-policy.ts");

beforeAll(() => {
  resetCompletenessGates();
  registerCompletenessGate({
    name: "MONEY_PATH_SLUGS (services/agents/infra-retry.ts)",
    enumerateSubjects: liveSlugs,
    classify: capabilityMemberClassifier(
      "infra-retry.ts",
      "MONEY_PATH_SLUGS",
      "money_path",
    ),
    reasonedExclusions: MONEY_PATH_EXCLUSIONS,
  });
  registerCompletenessGate({
    name: "ARTIFACT_PRODUCER_SLUGS (services/agents/slack-fresh-work-gate.ts)",
    enumerateSubjects: liveSlugs,
    classify: memberClassifier("slack-fresh-work-gate.ts", "ARTIFACT_PRODUCER_SLUGS"),
    reasonedExclusions: ARTIFACT_EXCLUSIONS,
  });
  registerCompletenessGate({
    name: "PII_SCRUB_AGENT_SLUGS (services/agents/scrub-agent-egress.ts)",
    enumerateSubjects: liveSlugs,
    classify: capabilityMemberClassifier(
      "scrub-agent-egress.ts",
      "PII_SCRUB_AGENT_SLUGS",
      "reads_operator_db",
      PII_SCRUB_DERIVE_EXCLUDE,
    ),
    reasonedExclusions: PII_SCRUB_EXCLUSIONS,
  });
  registerCompletenessGate({
    name: "STRUCTURED_RESCUE_SLUGS (services/agents/render-select.ts)",
    enumerateSubjects: liveSlugs,
    classify: memberClassifier("render-select.ts", "STRUCTURED_RESCUE_SLUGS"),
    reasonedExclusions: STRUCTURED_RESCUE_EXCLUSIONS,
  });
  registerCompletenessGate(
    toolSetGate(
      "REVENUE_TOOLS (agents/chief-of-staff/gmv-guard.ts)",
      REVENUE_TOOLS_FILE,
      "REVENUE_TOOLS",
    ),
  );
  registerCompletenessGate(
    toolSetGate(
      "FETCH_SERVERS (agents/research/claim-grounding.ts)",
      FETCH_SERVERS_FILE,
      "FETCH_SERVERS",
    ),
  );
  registerCompletenessGate(
    toolSetGate(
      "WRITE_TOOLS (services/agents/operator-policy.ts)",
      OPERATOR_POLICY_FILE,
      "const WRITE_TOOLS",
    ),
  );
  registerCompletenessGate(
    toolSetGate(
      "EXTERNAL_WRITE_TOOLS (services/agents/operator-policy.ts)",
      OPERATOR_POLICY_FILE,
      "const EXTERNAL_WRITE_TOOLS",
    ),
  );
});

describe("gate completeness (systemic anti-drift guard)", () => {
  it("enumerates a non-trivial live fleet (scan sanity — guards a vacuous pass)", () => {
    const slugs = liveSlugs();
    expect(slugs.length).toBeGreaterThanOrEqual(10);
    expect(slugs).toContain("engineer");
    expect(slugs).toContain("performance-marketer");
  });

  it("registers all eight gates (4 slug + 4 tool-name)", () => {
    expect(getRegisteredGates().map((g) => g.name)).toHaveLength(8);
  });

  it("tool-name gates parse a non-empty set (integrity floor — loud on rename/emptying)", () => {
    const revenue = getRegisteredGates().find((g) =>
      g.name.startsWith("REVENUE_TOOLS"),
    );
    const fetchG = getRegisteredGates().find((g) =>
      g.name.startsWith("FETCH_SERVERS"),
    );
    expect(revenue, "REVENUE_TOOLS gate not registered").toBeTruthy();
    expect(fetchG, "FETCH_SERVERS gate not registered").toBeTruthy();

    const revSubjects = (revenue as CompletenessGate).enumerateSubjects();
    const fetchSubjects = (fetchG as CompletenessGate).enumerateSubjects();
    expect(revSubjects.length).toBeGreaterThanOrEqual(4);
    expect(revSubjects).toContain("stripe__list_payouts");
    expect(fetchSubjects.length).toBeGreaterThanOrEqual(3);
    expect(fetchSubjects).toContain("web_search");
    expect(evaluateGate(revenue as CompletenessGate).uncovered).toEqual([]);
    expect(evaluateGate(fetchG as CompletenessGate).uncovered).toEqual([]);
  });

  it("operator write-set integrity floors parse non-empty + anchor known writes", () => {
    const writeG = getRegisteredGates().find((g) => g.name.startsWith("WRITE_TOOLS"));
    const extG = getRegisteredGates().find((g) =>
      g.name.startsWith("EXTERNAL_WRITE_TOOLS"),
    );
    expect(writeG, "WRITE_TOOLS gate not registered").toBeTruthy();
    expect(extG, "EXTERNAL_WRITE_TOOLS gate not registered").toBeTruthy();

    const writeSubjects = (writeG as CompletenessGate).enumerateSubjects();
    const extSubjects = (extG as CompletenessGate).enumerateSubjects();
    expect(writeSubjects.length).toBeGreaterThanOrEqual(5);
    expect(writeSubjects).toContain("github__open_pr");
    expect(writeSubjects).toContain("stripe__create_payment");
    expect(extSubjects).toContain("praxis__action");
    expect(extSubjects).not.toContain("memory__write");
  });

  const gateNames = [
    "MONEY_PATH_SLUGS (services/agents/infra-retry.ts)",
    "ARTIFACT_PRODUCER_SLUGS (services/agents/slack-fresh-work-gate.ts)",
    "PII_SCRUB_AGENT_SLUGS (services/agents/scrub-agent-egress.ts)",
    "STRUCTURED_RESCUE_SLUGS (services/agents/render-select.ts)",
  ];

  for (const name of gateNames) {
    it(`[${name}] every live agent is in-set OR has a documented reasoned-exclusion`, () => {
      const gate = getRegisteredGates().find((g) => g.name === name);
      expect(gate, `gate \`${name}\` was not registered`).toBeTruthy();
      const ev = evaluateGate(gate as CompletenessGate);

      expect(
        ev.uncovered,
        ev.uncovered.length === 0
          ? ""
          : `GATE DRIFT — these LIVE agents are neither a member of \`${name}\` ` +
              `nor carry a documented reasoned-exclusion. Each silently falls ` +
              `outside a customer-facing gate. Fix: add the slug to the set in ` +
              `the source file if it belongs, OR document a one-line ` +
              `reasoned-exclusion (reason "PENDING REVIEW — <slug>" if unsure) ` +
              `in gate-completeness.test.ts:\n` +
              ev.uncovered.map((s) => `  - ${s}`).join("\n"),
      ).toEqual([]);
    });
  }

  it("no stale reasoned-exclusions (every documented exclusion is a live agent)", () => {
    const stale: string[] = [];
    for (const gate of getRegisteredGates()) {
      for (const s of evaluateGate(gate).staleExclusions) {
        stale.push(`${gate.name}: ${s}`);
      }
    }
    expect(
      stale,
      stale.length === 0
        ? ""
        : `These reasoned-exclusions name slugs that are no longer live agents ` +
            `— remove the stale exemption:\n` + stale.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([]);
  });

  it("no misleading reasoned-exclusions (a documented exclusion is actually in-set)", () => {
    const misleading: string[] = [];
    for (const gate of getRegisteredGates()) {
      for (const s of evaluateGate(gate).misleadingExclusions) {
        misleading.push(`${gate.name}: ${s}`);
      }
    }
    expect(
      misleading,
      misleading.length === 0
        ? ""
        : `These slugs are documented as reasoned-exclusions but are ACTUALLY ` +
            `members of the set — the exclusion is misleading, drop it:\n` +
            misleading.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([]);
  });

  it("no blank reasoned-exclusions (every exclusion carries a real reason)", () => {
    const blank: string[] = [];
    for (const gate of getRegisteredGates()) {
      for (const s of evaluateGate(gate).blankExclusions) {
        blank.push(`${gate.name}: ${s}`);
      }
    }
    expect(
      blank,
      blank.length === 0
        ? ""
        : `These reasoned-exclusions have an empty reason — document why:\n` +
            blank.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([]);
  });
});
