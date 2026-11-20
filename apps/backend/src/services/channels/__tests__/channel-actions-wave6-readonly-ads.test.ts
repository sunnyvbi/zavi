
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  actionsStoreFor,
  allowedActionTypes,
  ACTION_TYPES,
  type ActionType,
} from "@zavi/shared";
import { deriveActionType, ACTION_TYPE_FAMILY_SETS, type DerivableStep } from "../action-type";
import { DELIVERABLE_KINDS } from "@/agents/lib/channel-recipe-step";

const SLUGS = ["linkedin_ads", "reddit_ads", "tiktok_ads"] as const;
type Slug = (typeof SLUGS)[number];
const MONEY_SLUGS = SLUGS;

const BACKEND = process.cwd();
const TOOLS_ROOT = path.join(BACKEND, "src", "services", "tools");
const agentMd = (slug: Slug) => path.join(BACKEND, "src", "agents", slug, "agent.md");

const TOOL_DIR: Record<Slug, string> = {
  linkedin_ads: "linkedin-ads",
  reddit_ads: "reddit-ads",
  tiktok_ads: "tiktok-ads",
};

type Fixture = {
  shape: string;
  step: DerivableStep;
  expected?: ActionType;
};

const LINKEDIN: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Confirm both spend-gate conditions before anything launches", deliverable: null },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "Install the Insight Tag and define one conversion event", deliverable: null },
    expected: "check",
  },
  {
    shape: "team-subscription-tool",
    step: { title: "Create a company page under a new slug", deliverable: null },
    expected: "check",
  },
  {
    shape: "booking-led-local-trade",
    step: { title: "Resolve the buyer mismatch before spending anything here", deliverable: null },
    expected: "check",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Save both audience definitions for when the verdict flips", deliverable: { kind: "list" } },
  },
];

const REDDIT: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Paste the three draft ads and the first flight into Ads Manager", deliverable: { kind: "ad" } },
    expected: "create_ad",
  },
  {
    shape: "paid-community",
    step: { title: "Verify the sidebar rules for the three communities by hand", deliverable: null },
    expected: "check",
  },
  {
    shape: "booking-led-local-trade",
    step: { title: "Add the pixel and the conversions API before spending more", deliverable: { kind: "brief" } },
    expected: "check",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Add one line to the contact page before the first ad goes live", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
];

const TIKTOK: Fixture[] = [
  {
    shape: "booking-led-local-trade",
    step: { title: "Claim a handle before shooting anything", deliverable: null },
    expected: "setup",
  },
  {
    shape: "team-subscription-tool",
    step: { title: "State a target cost per acquisition to size the entry test", deliverable: null },
    expected: "check",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Shoot the first concept and tag every take before posting", deliverable: { kind: "brief" } },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "Verify the pixel is installed and firing on the signup page", deliverable: null },
    expected: "check",
  },
];

const FIXTURES: Record<Slug, Fixture[]> = {
  linkedin_ads: LINKEDIN,
  reddit_ads: REDDIT,
  tiktok_ads: TIKTOK,
};

describe("wave 6: the three read-only ad channels are switched", () => {
  it.each(SLUGS)("%s reads and writes channel_actions", (slug) => {
    expect(actionsStoreFor(slug)).toBe("channel_actions");
  });

  it("the ad channel that DOES hold propose tools switched a wave later, with its rail", () => {
    expect(actionsStoreFor("youtube_ads")).toBe("channel_actions");
  });
});

describe.each(SLUGS)("%s: derived type is always one the registry allows", (slug) => {
  const fixtures = FIXTURES[slug];

  it("covers at least 3 different business shapes", () => {
    expect(new Set(fixtures.map((f) => f.shape)).size).toBeGreaterThanOrEqual(3);
  });

  it("every fixture derives a type inside this channel's action_types", () => {
    const allowed = allowedActionTypes(slug);
    expect(allowed.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      const { action_type } = deriveActionType(slug, f.step);
      expect(allowed, `${slug} / ${f.shape} / ${String(f.step.title)}`).toContain(action_type);
    }
  });

  it("derives the type each rule calls for", () => {
    for (const f of fixtures) {
      if (!f.expected) continue;
      const { action_type, coerced } = deriveActionType(slug, f.step);
      expect(action_type, `${slug} / ${f.shape} / ${String(f.step.title)}`).toBe(f.expected);
      expect(coerced, `${slug} / ${f.shape}: an expected type must not be a coercion`).toBe(false);
    }
  });

  it("a fixture with no expected type falls to `other`, which is always allowed", () => {
    for (const f of fixtures) {
      if (f.expected) continue;
      const { action_type } = deriveActionType(slug, f.step);
      expect(action_type, `${slug} / ${f.shape}`).toBe("other");
      expect(allowedActionTypes(slug)).toContain(action_type);
    }
  });

  it("no derivation family claims this channel", () => {
    for (const [family, members] of Object.entries(ACTION_TYPE_FAMILY_SETS)) {
      expect(members.has(slug), `${slug} joined the ${family} family`).toBe(false);
    }
  });

  it("no step on this channel can reach update_ad or pause_ad", () => {
    const titles = [
      "Pause the ad group that is not converting",
      "Update the daily budget on the live campaign",
      "Raise the max bid before the weekend",
      "Turn the second variant off",
    ];
    const reached = new Set<ActionType>();
    for (const kind of [...DELIVERABLE_KINDS, null]) {
      for (const title of [...titles, ""]) {
        reached.add(deriveActionType(slug, { title, deliverable: kind ? { kind } : null }).action_type);
      }
    }
    expect([...reached]).not.toContain("update_ad");
    expect([...reached]).not.toContain("pause_ad");
    expect(reached.size).toBeGreaterThan(3);
    for (const t of reached) expect(allowedActionTypes(slug)).toContain(t);
    expect(ACTION_TYPES).toContain("update_ad");
  });
});

function grantedTools(slug: Slug): string[] {
  const fm = matter(fs.readFileSync(agentMd(slug), "utf-8")).data as {
    metadata?: { praxis?: { tools?: string[] } };
  };
  return fm.metadata?.praxis?.tools ?? [];
}

describe("an `install` step is a check card, fleet-wide, and that is a finding not a fix", () => {
  it("a deliverable-less install step derives `check` on all three", () => {
    for (const slug of SLUGS) {
      for (const title of [
        "Install the tracking pixel before spending anything",
        "Install the conversion tag on the signup page",
      ]) {
        expect(deriveActionType(slug, { title, deliverable: null }), `${slug}: ${title}`).toEqual({
          action_type: "check",
          coerced: false,
        });
      }
    }
  });

  it("the account verbs still reach `setup`, so the gap is the verb and not the rule", () => {
    for (const slug of SLUGS) {
      expect(deriveActionType(slug, { title: "Claim the handle before shooting", deliverable: null }).action_type).toBe(
        "setup",
      );
      expect(
        deriveActionType(slug, { title: "Create an account and add a billing method", deliverable: null }).action_type,
      ).toBe("setup");
    }
  });
});

describe("wave 6: ad-account reads", () => {
  const WRITES: Record<Slug, string[]> = {
    reddit_ads: [
      "reddit_ads__propose_pause_campaign",
      "reddit_ads__propose_authorize_account",
      "reddit_ads__propose_prepare_campaign",
      "reddit_ads__propose_launch_campaign",
      "reddit_ads__propose_update_budget",
      "reddit_ads__propose_update_targeting",
      "reddit_ads__propose_update_ad",
      "reddit_ads__propose_replace_creative",
      "reddit_ads__propose_set_object_status",
      "reddit_ads__propose_rename_object",
      "reddit_ads__propose_remove_object",
    ],
    linkedin_ads: [
      "linkedin_ads__propose_pause_campaign",
      "linkedin_ads__propose_resume_campaign",
      "linkedin_ads__propose_budget_change",
      "linkedin_ads__propose_targeting_change",
      "linkedin_ads__propose_campaign_edit",
      "linkedin_ads__propose_campaign_group_edit",
      "linkedin_ads__propose_archive",
      "linkedin_ads__propose_ad_status",
      "linkedin_ads__propose_new_ad",
      "linkedin_ads__propose_ad_swap",
      "linkedin_ads__propose_new_campaign",
      "linkedin_ads__propose_duplicate",
      "linkedin_ads__propose_launch_campaign",
    ],
    tiktok_ads: ["tiktok_ads__propose_budget_change", "tiktok_ads__propose_status_change", "tiktok_ads__propose_launch"],
  };
  it("all three hold their account reads, and propose only through their governed cards", () => {
    for (const slug of SLUGS) {
      const granted = grantedTools(slug);
      const reads = [`${slug}__list_accounts`, `${slug}__list_campaigns`];
      for (const r of reads) {
        expect(granted).toContain(r);
      }
      const writes = granted.filter((t) => t.startsWith(`${slug}__propose`) || t.startsWith(`${slug}__set_`));
      expect(writes).toEqual(WRITES[slug]);
    }
  });

  const FAMILY: Record<Slug, string[]> = {
    reddit_ads: ["_exec-action.test.ts", "_exec-action.ts", "lifecycle-tools.test.ts", "lifecycle-tools.ts", "list_accounts.ts", "list_campaigns.ts", "propose_pause_campaign.ts", "read-tools.test.ts", "read-tools.ts"],
    linkedin_ads: [
      "__tests__",
      "_approver-role.ts",
      "_change-bodies.ts",
      "_exec-action.ts",
      "_groups.ts",
      "_objective.ts",
      "_wallet.ts",
      "analyst_brief.ts",
      "daily_series.ts",
      "list_accounts.ts",
      "list_ads.ts",
      "list_campaign_groups.ts",
      "list_campaigns.ts",
      "list_media.ts",
      "list_saved_audiences.ts",
      "measurement_health.ts",
      "preview_ad.ts",
      "propose_launch_campaign.ts",
      "propose_pause_campaign.ts",
      "read_analytics.ts",
      "recent_changes.ts",
      "search_targeting.ts",
      "write",
    ],
    tiktok_ads: ["__tests__", "_exec-action.ts", "launch.ts", "list_accounts.ts", "list_campaigns.ts", "propose_changes.ts", "read_tools.ts"],
  };
  it.each(MONEY_SLUGS)("%s declares itself a money channel, and its tool family is exactly reads + its governed writes", (slug) => {
    const fm = matter(fs.readFileSync(agentMd(slug), "utf-8")).data as {
      metadata?: { praxis?: { impact_classes?: string[]; capabilities?: { money_path?: boolean } } };
    };
    expect(fm.metadata?.praxis?.capabilities?.money_path).toBe(true);
    expect(fm.metadata?.praxis?.impact_classes).toEqual(["spend"]);
    expect(fs.readdirSync(path.join(TOOLS_ROOT, TOOL_DIR[slug])).sort()).toEqual(FAMILY[slug]);
  });
});
