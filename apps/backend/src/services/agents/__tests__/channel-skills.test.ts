import { describe, it, expect } from "vitest";
import path from "node:path";
import matter from "gray-matter";
import { readFileSync, readdirSync } from "node:fs";
import {
  applicableRouterSteps,
  resolveChannelSkillPath,
  readChannelSkill,
  buildChannelSkillBlock,
  MAX_CHANNEL_SKILL_BYTES,
  MAX_CHANNEL_SKILL_BLOCK_BYTES,
  type RouterStep,
} from "@/services/agents/channel-skills";

const step = (id: string, when: RouterStep["when"], skill?: string): RouterStep => ({
  id,
  when,
  goal: `goal ${id}`,
  skill,
});

describe("applicableRouterSteps — the honest-evidence gate", () => {
  const router: RouterStep[] = [
    step("indexability", "always", "diagnose"),
    step("account_read", "connected", "diagnose"),
    step("competitor_serp", "public_only", "rank"),
  ];

  it("with a connector: always + connected run, public_only is dropped", () => {
    const ids = applicableRouterSteps(router, true).map((s) => s.id);
    expect(ids).toEqual(["indexability", "account_read"]);
  });

  it("without a connector: always + public_only run, connected is dropped", () => {
    const ids = applicableRouterSteps(router, false).map((s) => s.id);
    expect(ids).toEqual(["indexability", "competitor_serp"]);
  });

  it("an unknown `when` value is dropped, not defaulted to always", () => {
    const bad = [{ id: "x", when: "sometimes" } as unknown as RouterStep];
    expect(applicableRouterSteps(bad, true)).toEqual([]);
    expect(applicableRouterSteps(bad, false)).toEqual([]);
  });

  it("tolerates a non-array / empty router", () => {
    expect(applicableRouterSteps([], true)).toEqual([]);
    expect(applicableRouterSteps(undefined as unknown as RouterStep[], true)).toEqual([]);
  });
});

describe("resolveChannelSkillPath — path safety", () => {
  const traversals = [
    "../../../../etc/passwd",
    "..",
    "../secrets",
    "a/b",
    "a\\b",
    ".env",
    "",
    "A",
    "1skill",
    "skill.md",
  ];

  it.each(traversals)("rejects skill name %j", (name) => {
    expect(resolveChannelSkillPath("seo", name)).toBeNull();
  });

  it.each(traversals)("rejects channel slug %j", (slug) => {
    expect(resolveChannelSkillPath(slug, "diagnose")).toBeNull();
  });

  it("returns null for a well-formed but nonexistent pair", () => {
    expect(resolveChannelSkillPath("nosuchchannel", "diagnose")).toBeNull();
  });
});

describe("readChannelSkill", () => {
  it("returns null rather than throwing when the file is absent", () => {
    expect(readChannelSkill("nosuchchannel", "diagnose")).toBeNull();
  });

  it("returns null for a rejected name", () => {
    expect(readChannelSkill("seo", "../../package")).toBeNull();
  });
});

describe("readChannelSkill — the clamp is LOUD and fits the cap", () => {
  const REAL = { channel: "x_organic", skill: "diagnose" };

  it("a body under the cap is returned whole and unmarked", () => {
    const body = readChannelSkill(REAL.channel, REAL.skill);
    expect(body, `${REAL.channel}/${REAL.skill} did not resolve`).toBeTruthy();
    expect(Buffer.byteLength(body!, "utf-8")).toBeLessThanOrEqual(MAX_CHANNEL_SKILL_BYTES);
    expect(body).not.toContain("[channel skill truncated");
  });

  it("no shipped channel skill comes back marked as truncated", () => {
    const root = path.join(process.cwd(), "src", "agents");
    const marked: string[] = [];
    for (const ch of readdirSync(root, { withFileTypes: true })) {
      if (!ch.isDirectory()) continue;
      const skills = path.join(root, ch.name, "skills");
      let entries: string[] = [];
      try {
        entries = readdirSync(skills);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".md")) continue;
        const body = readChannelSkill(ch.name, f.replace(/\.md$/, ""));
        if (body?.includes("[channel skill truncated")) marked.push(`${ch.name}/${f}`);
      }
    }
    expect(marked, `these lose their tail in prod:\n${marked.join("\n")}`).toEqual([]);
  });
});

describe("buildChannelSkillBlock", () => {
  it("empty block when nothing resolves, and names what was missing", () => {
    const out = buildChannelSkillBlock("nosuchchannel", [
      step("a", "always", "diagnose"),
      step("b", "always", "rank"),
    ]);
    expect(out.block).toBe("");
    expect(out.skills).toEqual([]);
    expect(out.missing).toEqual(["diagnose", "rank"]);
  });

  it("steps with no skill contribute nothing and are not reported missing", () => {
    const out = buildChannelSkillBlock("nosuchchannel", [step("a", "always")]);
    expect(out.block).toBe("");
    expect(out.missing).toEqual([]);
  });

  it("dedupes a skill bound by more than one step", () => {
    const out = buildChannelSkillBlock("nosuchchannel", [
      step("a", "always", "diagnose"),
      step("b", "always", "diagnose"),
    ]);
    expect(out.missing).toEqual(["diagnose"]);
  });
});

describe("shared skills", () => {
  it("resolves a shared skill for a channel that has no such file of its own", () => {
    const p = resolveChannelSkillPath("tiktok_organic", "generated_video");
    expect(p).toBeTruthy();
    expect(p).toContain(`${path.sep}_core${path.sep}ads${path.sep}`);
  });

  it("reads the shared body, not an empty string", () => {
    const v = readChannelSkill("tiktok_organic", "generated_video");
    expect(v && v.length).toBeGreaterThan(500);
  });

  it("a channel's OWN skill still wins over the shared one", () => {
    const own = resolveChannelSkillPath("seo", "diagnose");
    expect(own).toContain(`${path.sep}seo${path.sep}skills${path.sep}`);
    expect(own).not.toContain(`${path.sep}_core${path.sep}ads${path.sep}`);
  });

  it("every existing per-channel skill still resolves under its own channel", () => {
    for (const c of ["seo", "meta_ads", "reddit_organic"]) {
      for (const s of ["diagnose", "rank", "artifact"]) {
        expect(resolveChannelSkillPath(c, s)).toContain(`${path.sep}${c}${path.sep}`);
      }
    }
  });

  it("still refuses traversal, on both roots", () => {
    expect(resolveChannelSkillPath("seo", "../../../etc/passwd")).toBeNull();
    expect(resolveChannelSkillPath("../../etc", "generated_video")).toBeNull();
    expect(resolveChannelSkillPath("_core", "../../../etc/passwd")).toBeNull();
  });

  it("still refuses a malformed channel or skill name", () => {
    expect(resolveChannelSkillPath("Seo", "diagnose")).toBeNull();
    expect(resolveChannelSkillPath("seo", "Diagnose")).toBeNull();
    expect(resolveChannelSkillPath("seo", "diag.nose")).toBeNull();
  });

  it("returns null for a skill that exists in neither root", () => {
    expect(resolveChannelSkillPath("seo", "no_such_skill")).toBeNull();
    expect(readChannelSkill("seo", "no_such_skill")).toBeNull();
  });
});

describe("corpus boundary — SEO/GEO playbooks are not channel skills", () => {
  const PLAYBOOK_SLUGS = [
    "geo-audit",
    "seo-technical",
    "seo-page",
    "seo-schema",
    "seo-content",
    "seo-content-brief",
  ];

  it("no SEO/GEO playbook resolves through the channel roots", () => {
    for (const slug of PLAYBOOK_SLUGS) {
      expect(resolveChannelSkillPath("seo", slug), `${slug} must not resolve`).toBeNull();
      expect(readChannelSkill("seo", slug), `${slug} body must not load`).toBeNull();
    }
  });

  it("binding one from a recipe would report it missing, not silently inject it", () => {
    const built = buildChannelSkillBlock("seo", [step("geo", "always", "geo-audit")]);
    expect(built.block).toBe("");
    expect(built.skills).toEqual([]);
    expect(built.missing).toEqual(["geo-audit"]);
  });

  it("the triad the seo recipe actually binds does resolve", () => {
    for (const name of ["diagnose", "rank", "artifact"]) {
      expect(readChannelSkill("seo", name), `${name} must load`).not.toBeNull();
    }
  });

  it("generic-dispatcher keeps keyword auto-inject as the else-if, not a fallback", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src", "services", "agents", "generic-dispatcher.ts"),
      "utf-8",
    );

    const injectBranch = src.lastIndexOf("if (channelRouter.applicable !== null) {");
    const keywordCall = src.indexOf("buildAutoInjectedSkillBlock(");
    expect(injectBranch, "channel injection branch must exist").toBeGreaterThan(-1);
    expect(keywordCall, "keyword injector must exist").toBeGreaterThan(-1);
    expect(
      keywordCall,
      "keyword injector must come AFTER the channel branch",
    ).toBeGreaterThan(injectBranch);

    const between = src.slice(injectBranch, keywordCall);
    expect(
      between,
      "keyword auto-inject must be chained as `} else if (` off the channel branch — " +
        "if this fails, a channel_recipe run may now ALSO keyword-inject, and the " +
        "resolver assertions above will not catch it",
    ).toContain("} else if (");
  });
});

const skills = [
  "evidence", "measurement", "search", "negatives",
  "pmax", "video", "architect", "build_sheet",
  "creative", "causality", "execution",
];
const YOUTUBE_SKILLS = ["video", "creative"];
const sections = ["When to use / When NOT to use", "Evidence", "Decision rules", "Output", "Never claim", "Before you hand over"];
const sourceTag = /\[(?:PLATFORM FACT https:\/\/[^\]]+|PRACTITIONER CONVENTION [^\]]+|ZAVI CONVENTION)\]/;
const threshold = /(?:[<>≤≥]=?|(?:under|over|at least|at most|above|below)\s+)\s*\d[\d,.]*(?:\s*%|\s+(?:mature\s+)?(?:conversions?|clicks?|impressions?|views?|days?)\b)|\b\d+(?:\.\d+)?\s*[×x]\s*(?:target|tCPA|tROAS|CPA)\b|\b(?:scale|raise|increase|reduce|decrease|step|ceiling|floor|cap|utilisation|pressure|split|loosen|allocation)\b[^.\n]{0,80}\d[\d,.–-]*\s*%/i;

function lintLines(body: string): string[] {
  const errors: string[] = [];
  for (const [index, line] of body.split("\n").entries()) {
    if (threshold.test(line) && !sourceTag.test(line)) errors.push(`${index + 1}: untagged threshold: ${line}`);
    if (/pmax (?:search terms|queries) (?:are not|aren't) available/i.test(line) && !/never|do not/i.test(line)) errors.push(`${index + 1}: missing PMax terms`);
    if (/budget change resets learning/i.test(line) && !/never|do not/i.test(line)) errors.push(`${index + 1}: budget learning claim`);
    if (/keywords are created PAUSED/i.test(line) && !/never|do not|not true/i.test(line)) errors.push(`${index + 1}: keyword status claim`);
    if (/video action campaign/i.test(line) && !/no new|never|not |retired|legacy|migration|do not|unavailable/i.test(line)) errors.push(`${index + 1}: retired campaign recommendation`);
  }
  return errors;
}

describe("ads skill content contract", () => {
  it.each(skills)("validates %s without relying on truncated runtime content", (slug) => {
    const owner = YOUTUBE_SKILLS.includes(slug) ? "youtube_ads" : "google_ads";
    const file = resolveChannelSkillPath(owner, slug);
    expect(file).not.toBeNull();
    const raw = readFileSync(file!, "utf8");
    const { data, content } = matter(raw);
    expect(data.name).toBe(slug);
    expect(data.description).toBeTypeOf("string");
    expect(data.applies_to.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(raw)).toBeLessThan(MAX_CHANNEL_SKILL_BYTES);
    expect(raw.trim().split("\n").length).toBeGreaterThanOrEqual(80);
    expect(raw.trim().split("\n").length).toBeLessThanOrEqual(slug === "evidence" ? 150 : 180);
    for (const section of sections) expect(content).toContain(`## ${section}`);
    expect(lintLines(content)).toEqual([]);
    const evidence = content.split("## Evidence")[1].split("## Decision rules")[0];
    for (const line of evidence.split("\n").filter((line) => line.startsWith("- "))) {
      expect(line).toMatch(/^- (REQUIRED_FOR_ACTION|OPTIONAL_CONFIDENCE|DIAGNOSTIC_ONLY):/);
    }
    for (const agent of data.applies_to as string[]) {
      const grants: string[] = matter(readFileSync(`src/agents/${agent}/agent.md`, "utf8")).data.metadata.praxis.tools;
      for (const match of content.matchAll(/google_ads__[a-z_]+/g)) expect(grants, `${slug}: ${agent}: ${match[0]}`).toContain(match[0]);
    }
    for (const match of content.matchAll(/\[PLATFORM FACT ([^\]]+)\]/g)) {
      expect(new URL(match[1]).hostname).toMatch(/(^|\.)(google\.com|thinkwithgoogle\.com)$/);
    }
  });

  it("rejects regressions while allowing explicit prohibitions", () => {
    for (const text of ["Scale by 30%", "Spend 2× target", "Under 10 mature conversions", "Utilisation ≥95%", "PMax search terms are not available", "A budget change resets learning", "Positive keywords are created PAUSED", "Create a Video Action Campaign"]) {
      expect(lintLines(text).length, text).toBeGreaterThan(0);
    }
    expect(lintLines("Withheld impression share is null, never 0%.\nNo more than three loads.\nNo more than 3 on-demand loads.\nSupply 16:9 and 9:16 assets.\nThe formula uses × and x target symbols.")).toEqual([]);
    expect(lintLines("Never claim a budget change resets learning.\nNo new Video Action Campaigns.\nRaise by 20% [ZAVI CONVENTION]")).toEqual([]);
  });
});

describe("channel-specific ads recipe instructions", () => {
  it.each(["google_ads", "youtube_ads"])("only tells %s to load its own skills", (channel) => {
    const recipe = matter(readFileSync(`src/channels/${channel}/recipe.md`, "utf8"));
    const forbidden = channel === "google_ads"
      ? ["video", "creative"]
      : ["search", "pmax", "negatives", "build_sheet"];
    const steps = recipe.data.router as RouterStep[];
    const bound = steps.map((s) => s.skill).filter(Boolean);
    for (const slug of forbidden) expect(bound, `${channel} binds ${slug}`).not.toContain(slug);
    for (const connected of [true, false]) {
      const built = buildChannelSkillBlock(channel, applicableRouterSteps(steps, connected));
      expect(built.missing).toEqual([]);
      expect(built.skills).toContain("evidence");
      if (!connected) expect(built.skills).toContain(channel === "google_ads" ? "build_sheet" : "creative");
    }
  });
});

describe("channel playbooks are injected, never left to skill__load", () => {
  const channels = readdirSync("src/channels", { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_base")
    .map((d) => d.name);

  it.each(channels)("%s injects its playbooks within the aggregate cap", (channel) => {
    const recipe = matter(readFileSync(`src/channels/${channel}/recipe.md`, "utf8"));
    const steps = (recipe.data.router ?? []) as RouterStep[];
    for (const connected of [true, false]) {
      const built = buildChannelSkillBlock(channel, applicableRouterSteps(steps, connected));
      expect(built.block).not.toContain("skill__load");
      expect(built.missing).toEqual([]);
      expect(Buffer.byteLength(built.block, "utf-8")).toBeLessThanOrEqual(MAX_CHANNEL_SKILL_BLOCK_BYTES);
    }
  });

  it("google_ads injects all eight playbooks on a connected run", () => {
    const recipe = matter(readFileSync("src/channels/google_ads/recipe.md", "utf8"));
    const built = buildChannelSkillBlock("google_ads", applicableRouterSteps(recipe.data.router, true));
    expect(built.skills.sort()).toEqual(
      ["architect", "causality", "evidence", "execution", "measurement", "negatives", "pmax", "search"].sort(),
    );
  });

  it("youtube_ads injects its seven playbooks on a connected run", () => {
    const recipe = matter(readFileSync("src/channels/youtube_ads/recipe.md", "utf8"));
    const built = buildChannelSkillBlock("youtube_ads", applicableRouterSteps(recipe.data.router, true));
    expect(built.skills.sort()).toEqual(
      ["architect", "causality", "creative", "evidence", "execution", "measurement", "video"].sort(),
    );
  });

  it("an on_demand step is injected like any other (the key is ignored)", () => {
    const built = buildChannelSkillBlock("google_ads", [
      { id: "s", when: "connected", skill: "search", load: "on_demand" },
    ] as RouterStep[]);
    expect(built.skills).toEqual(["search"]);
    expect(built.block).toContain("## Skill playbook: search");
  });
});
