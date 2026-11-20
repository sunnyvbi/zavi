
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { actionsStoreFor, allowedActionTypes, ACTION_TYPES, type ActionType } from "@zavi/shared";
import { deriveActionType, type DerivableStep } from "../action-type";
import { DELIVERABLE_KINDS } from "@/agents/lib/channel-recipe-step";

const SLUG = "chatgpt_ads";
const BACKEND = process.cwd();
const TOOLS_ROOT = path.join(BACKEND, "src", "services", "tools");
const AGENT_MD = path.join(BACKEND, "src", "agents", SLUG, "agent.md");

type Fixture = {
  shape: string;
  step: DerivableStep;
  expected?: ActionType;
};

const FIXTURES: Fixture[] = [
  {
    shape: "team-subscription-tool",
    step: { title: "Paste the three ad groups and their chat cards into Ads Manager", deliverable: { kind: "ad" } },
    expected: "create_ad",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Confirm which policy category the billed business falls under", deliverable: null },
    expected: "check",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Check whether self-serve is open where the business is billed", deliverable: null },
    expected: "check",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Create an account in Ads Manager and add a billing method", deliverable: null },
    expected: "setup",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "The feed rows for the six products with a price on the page", deliverable: { kind: "list" } },
  },
  {
    shape: "paid-community",
    step: { title: "What the two blocking rows mean before any ad is submitted", deliverable: { kind: "brief" } },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "Build the missing page each ad group can land on", deliverable: { kind: "page_copy" } },
    expected: "fix",
  },
];

describe("wave 4: chatgpt_ads is switched", () => {
  it("chatgpt_ads reads and writes channel_actions", () => {
    expect(actionsStoreFor(SLUG)).toBe("channel_actions");
  });

  it("the ad channels that DO hold propose tools switch only WITH an exec rail", () => {
    expect(actionsStoreFor("meta_ads")).toBe("channel_actions");
    expect(actionsStoreFor("youtube_ads")).toBe("channel_actions");
  });
});

describe("chatgpt_ads: derived type is always one the registry allows", () => {
  it("covers at least 3 different business shapes", () => {
    expect(new Set(FIXTURES.map((f) => f.shape)).size).toBeGreaterThanOrEqual(3);
  });

  it("every fixture derives a type inside this channel's action_types", () => {
    const allowed = allowedActionTypes(SLUG);
    expect(allowed.length).toBeGreaterThan(0);
    for (const f of FIXTURES) {
      const { action_type } = deriveActionType(SLUG, f.step);
      expect(allowed, `${SLUG} / ${f.shape} / ${String(f.step.title)}`).toContain(action_type);
    }
  });

  it("derives the type each rule calls for", () => {
    for (const f of FIXTURES) {
      if (!f.expected) continue;
      const { action_type, coerced } = deriveActionType(SLUG, f.step);
      expect(action_type, `${SLUG} / ${f.shape} / ${String(f.step.title)}`).toBe(f.expected);
      expect(coerced, `${SLUG} / ${f.shape}: an expected type must not be a coercion`).toBe(false);
    }
  });

  it("a fixture with no expected type falls to `other`, which is always allowed", () => {
    for (const f of FIXTURES) {
      if (f.expected) continue;
      const { action_type } = deriveActionType(SLUG, f.step);
      expect(action_type, `${SLUG} / ${f.shape}`).toBe("other");
      expect(allowedActionTypes(SLUG)).toContain(action_type);
    }
  });

  it("the two ways a step reaches `other` are counted differently, and only one is a signal", () => {
    expect(deriveActionType(SLUG, {
      title: "The three intents worth an ad group at all",
      deliverable: { kind: "list" },
    })).toEqual({ action_type: "other", coerced: false });
    expect(deriveActionType(SLUG, {
      title: "The reply to leave under the mention",
      deliverable: { kind: "comment" },
    })).toEqual({ action_type: "other", coerced: true });
  });

  it("no derivation branch claims this channel", () => {
    expect(deriveActionType(SLUG, {
      title: "Draft the missing landing page for the second intent",
      deliverable: { kind: "page_copy" },
    }).action_type).toBe("fix");
    expect(deriveActionType(SLUG, {
      title: "The copy itself",
      deliverable: { kind: "email" },
    })).toEqual({ action_type: "other", coerced: true });
  });
});

function grantedTools(): string[] {
  const fm = matter(fs.readFileSync(AGENT_MD, "utf-8")).data as {
    metadata?: { praxis?: { tools?: string[] } };
  };
  return fm.metadata?.praxis?.tools ?? [];
}

function toolFile(tool: string): string | null {
  const [family, name] = tool.split("__");
  if (!family || !name) return null;
  const p = path.join(TOOLS_ROOT, family.replace(/_/g, "-"), `${name}.ts`);
  return fs.existsSync(p) ? p : null;
}

function emitterFiles(): string[] {
  const MARKERS = ["emit_decision", "recordChannelExecAction", "resolveGoogleAdsEmit", "_exec-action"];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const src = fs.readFileSync(p, "utf-8");
        if (e.name.startsWith("propose_") || MARKERS.some((m) => src.includes(m))) out.push(p);
      }
    }
  };
  walk(TOOLS_ROOT);
  return out;
}

describe("chatgpt_ads executes only through its own three propose tools", () => {
  it("the grant holds no OTHER channel's approval-rail emitter", () => {
    const emitters = new Set(emitterFiles());
    expect(emitters.size, "the emitter scan found nothing, so it is broken").toBeGreaterThanOrEqual(10);

    const granted = grantedTools();
    const resolved = granted.map(toolFile).filter((p): p is string => p !== null);
    expect(resolved.length, "no granted tool resolved to a file").toBeGreaterThanOrEqual(8);

    expect(resolved.filter((p) => emitters.has(p))).toEqual([]);
  });

  it("the only propose tools in the grant are its own three, and no ad-mutation tool", () => {
    const granted = grantedTools();
    expect(granted.length, "the grant did not parse").toBeGreaterThan(5);
    const proposers = granted.filter((t) => (t.split("__")[1] ?? "").startsWith("propose_")).sort();
    expect(proposers).toEqual([
      "chatgpt_ads__propose_budget_change",
      "chatgpt_ads__propose_new_campaign",
      "chatgpt_ads__propose_status",
    ]);
    for (const t of ["praxis__action", "praxis__propose_dispatch", "praxis__propose_standing_order", "praxis__propose_research_watch"]) {
      expect(granted).not.toContain(t);
    }
    for (const t of granted) {
      expect(/set_status|update_campaign|remove_resource|create_ad\b|add_keywords/.test(t), `${t} mutates ads`).toBe(false);
    }
  });

  it("`exec_class` is written only by the known exec writers, and chatgpt_ads reaches only its own", () => {
    const callers = emitterFiles().filter((p) =>
      fs.readFileSync(p, "utf-8").includes("recordChannelExecAction("),
    );
    expect(callers.map((p) => path.relative(TOOLS_ROOT, p)).sort()).toEqual([
      path.join("chatgpt-ads", "propose.ts"),
      path.join("email-campaign", "_exec-action.ts"),
      path.join("generated-video", "animate_image.ts"),
      path.join("generated-video", "propose_video.ts"),
      path.join("google-ads", "write", "_exec-action.ts"),
      path.join("linkedin-ads", "_exec-action.ts"),
      path.join("meta-ads", "write", "_exec-action.ts"),
      path.join("reddit-ads", "_exec-action.ts"),
      path.join("seo", "file-pr-card.ts"),
      path.join("tiktok-ads", "_exec-action.ts"),
      path.join("x-ads", "_exec-action.ts"),
    ]);
    const own = fs.readFileSync(path.join(TOOLS_ROOT, "chatgpt-ads", "propose.ts"), "utf-8");
    expect(own).toContain('resolveChannelExecEmit(new Set(["chatgpt_ads"])');
    expect(own).toContain("CHATGPT_GROWTH_CLASSES.has(a.decision_class)");
    expect(grantedTools()).not.toContain("generated_video__propose");
    expect(grantedTools()).not.toContain("generated_video__animate");
    const animate = fs.readFileSync(path.join(TOOLS_ROOT, "generated-video", "animate_image.ts"), "utf-8");
    expect(animate).toContain('new Set(["generated_video", "youtube_organic"])');
    expect(grantedTools()).not.toContain("seo__propose_pr");
    expect(grantedTools()).not.toContain("geo__propose_pr");
    expect(grantedTools()).not.toContain("email__propose_campaign");
    expect(grantedTools()).not.toContain("reddit_ads__propose_pause_campaign");
    expect(grantedTools().some((t) => t.startsWith("x_ads__propose"))).toBe(false);
    expect(grantedTools().some((t) => t.startsWith("linkedin_ads__"))).toBe(false);
    expect(grantedTools().some((t) => t.startsWith("tiktok_ads__"))).toBe(false);
    const tiktok = fs.readFileSync(path.join(TOOLS_ROOT, "tiktok-ads", "_exec-action.ts"), "utf-8");
    expect(tiktok).toContain('resolveChannelExecEmit(new Set(["tiktok_ads"])');
  });

  it("the agent's own frontmatter declares the money path it now holds", () => {
    const fm = matter(fs.readFileSync(AGENT_MD, "utf-8")).data as {
      metadata?: { praxis?: { impact_classes?: string[]; capabilities?: { money_path?: boolean } } };
    };
    expect(fm.metadata?.praxis?.capabilities?.money_path).toBe(true);
    expect(fm.metadata?.praxis?.impact_classes).toEqual(["comms", "spend"]);
  });

  it("no step on this channel can reach update_ad or pause_ad", () => {
    const titles = [
      "Pause the ad group that is not converting",
      "Update the daily budget on the live campaign",
      "Raise the max bid before the weekend",
      "Turn off the second chat card",
    ];
    const reached = new Set<ActionType>();
    for (const kind of [...DELIVERABLE_KINDS, null]) {
      for (const title of [...titles, ""]) {
        reached.add(deriveActionType(SLUG, { title, deliverable: kind ? { kind } : null }).action_type);
      }
    }
    expect([...reached]).not.toContain("update_ad");
    expect([...reached]).not.toContain("pause_ad");
    expect(reached.size).toBeGreaterThan(3);
    for (const t of reached) expect(allowedActionTypes(SLUG)).toContain(t);
    expect(ACTION_TYPES).toContain("update_ad");
  });
});
