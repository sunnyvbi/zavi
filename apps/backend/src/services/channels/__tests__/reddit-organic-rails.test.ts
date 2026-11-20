import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const RECIPE = "src/channels/reddit_organic/recipe.md";
const AGENT = "src/agents/reddit_organic/agent.md";
const SKILLS = [
  "src/agents/reddit_organic/skills/angle.md",
  "src/agents/reddit_organic/skills/artifact.md",
  "src/agents/reddit_organic/skills/community.md",
  "src/agents/reddit_organic/skills/diagnose.md",
  "src/agents/reddit_organic/skills/draft.md",
  "src/agents/reddit_organic/skills/kit.md",
  "src/agents/reddit_organic/skills/potential.md",
  "src/agents/reddit_organic/skills/rank.md",
];
const FILES = [RECIPE, AGENT, ...SKILLS];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const frontmatter = (rel: string) => {
  const raw = read(rel);
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
};

const routerSteps = () => {
  const fm = frontmatter(RECIPE);
  const idx = fm.indexOf("\nrouter:");
  expect(idx).toBeGreaterThan(-1);
  return fm
    .slice(idx)
    .split(/\n\s+- id: /)
    .slice(1)
    .map((chunk) => ({
      id: chunk.split("\n")[0].trim(),
      goal:
        /\n?\s*goal:\s*([\s\S]*?)(?=\n\s+(?:skill|tools|when):)/.exec(
          chunk,
        )?.[1] ?? "",
      skill: /\n\s*skill:\s*(\S+)/.exec(chunk)?.[1] ?? "",
      tools: /\n\s*tools:\s*\[(.*?)\]/s.exec(chunk)?.[1] ?? "",
    }));
};

describe("the reddit_organic capsule is complete and loads", () => {
  it("every capsule file exists", () => {
    expect(FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)))).toEqual([]);
  });

  it("the recipe loads through the real loader, schema and all", async () => {
    const { loadChannelRecipe } = await import("../recipe");
    const recipe = loadChannelRecipe("reddit_organic");
    const router = recipe.meta.router ?? [];
    expect(router.length).toBeGreaterThan(3);
    const over = router
      .map((s) => ({
        id: s.id,
        len: s.goal.replace(/\s+/g, " ").trim().length,
      }))
      .filter((s) => s.len > 300);
    expect(over).toEqual([]);
  });

  it("every skill a router step names exists on disk", async () => {
    const { loadChannelRecipe } = await import("../recipe");
    const missing = (loadChannelRecipe("reddit_organic").meta.router ?? [])
      .map((s) => s.skill)
      .filter((s): s is string => !!s)
      .filter(
        (s) =>
          !fs.existsSync(
            path.join(ROOT, `src/agents/reddit_organic/skills/${s}.md`),
          ),
      );
    expect(missing).toEqual([]);
  });

  it("no skill body exceeds the channel-skill byte cap", async () => {
    const { MAX_CHANNEL_SKILL_BYTES } =
      await import("@/services/agents/channel-skills");
    const over = SKILLS.map((f) => ({
      f,
      bytes: Buffer.byteLength(read(f), "utf-8"),
    })).filter((x) => x.bytes > MAX_CHANNEL_SKILL_BYTES);
    expect(over).toEqual([]);
  });
});

describe("the capsule's Reddit reads are bound to the tools that can make them", () => {
  it("both the existing Q&A lane and added post lane bind the Reddit search rail", () => {
    const steps = routerSteps();
    for (const id of ["thread_discovery", "mention_sweep", "post_community"]) {
      const step = steps.find((s) => s.id === id);
      expect(step, `${id} missing from the router`).toBeDefined();
      expect(step!.tools, `${id} does not bind apify__scrape_reddit`).toContain(
        "apify__scrape_reddit",
      );
    }
  });

  it("the existing answer-ownership and viability steps retain their thread reads", () => {
    for (const id of ["answer_ownership", "target_viability"]) {
      const step = routerSteps().find((s) => s.id === id);
      expect(step, `${id} missing from the router`).toBeDefined();
      expect(step!.tools).toContain("reddit_thread_read");
    }
  });

  it("the agent declares both Reddit rails and a raised iteration cap", () => {
    const agent = read(AGENT);
    expect(agent).toMatch(/^\s+- apify__scrape_reddit$/m);
    expect(agent).toMatch(/^\s+- reddit__thread_read$/m);
    const cap = Number(/tool_iter_cap:\s*(\d+)/.exec(agent)![1]);
    expect(cap).toBeGreaterThan(60);
    expect(cap).toBeLessThanOrEqual(120);
  });

  it("no router step pairs web_fetch with a Reddit target", () => {
    const bad = routerSteps()
      .filter(
        (s) =>
          /web_fetch/.test(s.tools) && /reddit|subreddit|thread/i.test(s.goal),
      )
      .map((s) => s.id);
    expect(bad).toEqual([]);
  });

  it("no capsule file calls the Reddit render rail dead or impossible", () => {
    const bad: string[] = [];
    const DEAD =
      /(measured dead|is dead on reddit|cannot reach reddit|no rail returns them|comments are unreadable|reddit refuses (?:our|the) (?:render|actor))/i;
    for (const f of FILES) {
      for (const line of read(f).split("\n")) {
        if (!DEAD.test(line)) continue;
        if (
          /was wrong|earlier version|root cause|corrected|used to|no longer|history/i.test(
            line,
          )
        ) {
          continue;
        }
        bad.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the capsule says the sidebar is where a subreddit's rules are", () => {
    const community = read("src/agents/reddit_organic/skills/community.md");
    expect(community).toMatch(/sidebar/i);
    expect(community).toMatch(/verbatim/i);
    const bad: string[] = [];
    for (const f of FILES) {
      for (const line of read(f).split("\n")) {
        if (
          !/rules? (?:text )?(?:are|is|stays?|remain) .{0,20}auth-?walled|cannot read .{0,20}rules/i.test(
            line,
          )
        ) {
          continue;
        }
        if (
          /was wrong|earlier|used to|no longer|out of date|corrected/i.test(
            line,
          )
        )
          continue;
        bad.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("reddit_organic never claims a rank it cannot read", () => {
  const RANK_CLAIMS = [
    /\branks?\s+(?:at\s+)?#\d/i,
    /\bposition\s+#?\d/i,
    /\branks?\s+(?:at\s+)?position\b/i,
    /\bSERP position\b/i,
  ];

  it("no capsule file states a numeric rank or position", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const re of RANK_CLAIMS) {
        for (const line of read(f).split("\n")) {
          if (!re.test(line)) continue;
          if (
            /never|not\b|illegal|invented|do not|cannot|delete it|—/i.test(line)
          )
            continue;
          bad.push(`${f}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the capsule names the search instrument as Tavily, not Google", () => {
    const carriers = FILES.filter((f) => /tavily/i.test(read(f)));
    expect(carriers.length).toBeGreaterThanOrEqual(2);
  });
});

describe("reddit_organic does not resurrect the ungated-submission claim", () => {
  it("no file claims a post or comment clears every gate", () => {
    const CLAIM =
      /trips? no (?:submission )?gate|needs no permission and (?:trips|clears)/gi;
    const bad: string[] = [];
    for (const f of FILES) {
      const flat = read(f).replace(/\s+/g, " ");
      for (const m of flat.matchAll(CLAIM)) {
        const before = flat.slice(Math.max(0, m.index - 120), m.index);
        if (/never|not\b|wrong|do not|no capsule|saying/i.test(before))
          continue;
        bad.push(`${f}: ${flat.slice(m.index, m.index + 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the spam_comments constants are named as legacy wherever they appear", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      const body = read(f);
      if (!/spam_comments|spam_selfposts/.test(body)) continue;
      if (
        !/reddit-archive|legacy|stopped running|r2 codebase|do not repeat/i.test(
          body,
        )
      ) {
        bad.push(
          `${f}: cites the r2 spam constants without marking them retired`,
        );
      }
    }
    expect(bad).toEqual([]);
  });

  it("the capsule names the gates that actually exist today", () => {
    const corpus = [read(AGENT), read(RECIPE)].join("\n");
    expect(corpus).toMatch(/AutoModerator/);
    expect(corpus).toMatch(/Contributor Quality Score/);
    expect(corpus).toMatch(/contributor_quality/);
  });
});

describe("reddit_organic never implies Zavi can post to Reddit", () => {
  it("the agent grants no Reddit write or propose tool", () => {
    const fm = frontmatter(AGENT);
    const granted = fm
      .slice(fm.indexOf("\n    tools:"))
      .split("\n")
      .map((l) => /^\s+-\s+(\S+)$/.exec(l)?.[1])
      .filter((x): x is string => !!x);
    expect(granted).not.toContain("social__propose_post");
    expect(
      granted.filter((t) => /submit|publish|propose_post/i.test(t)),
    ).toEqual([]);
  });

  it("the recipe's artifact tool is not a publishing tool", () => {
    expect(frontmatter(RECIPE)).not.toMatch(/tool:\s*social_propose_post/);
  });

  it("no capsule file says Zavi posts, stages or schedules on Reddit", () => {
    const CLAIM =
      /\b(?:zavi|we)\s+(?:will\s+)?(?:post|posts|posted|publish|publishes|published|schedules?|scheduled|stages?|staged|submits?|submitted)\s+(?:it\s+)?(?:to|on|the)?\s*(?:reddit|r\/)/i;
    const bad: string[] = [];
    for (const f of FILES) {
      for (const line of read(f).split("\n")) {
        if (!CLAIM.test(line)) continue;
        if (/never|not\b|does not|cannot|do not|no longer|used to/i.test(line))
          continue;
        bad.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the agent says plainly that this is not an integration", () => {
    const agent = read(AGENT);
    expect(agent).toMatch(/not a Reddit integration/i);
    expect(agent).toMatch(
      /does not (?:connect to or )?publish|founder copies/i,
    );
  });
});

describe("post potential is directional, not fabricated reach", () => {
  const potential = () => read("src/agents/reddit_organic/skills/potential.md");

  it("uses qualitative levels and refuses score-to-view conversion", () => {
    const body = potential();
    expect(body).toMatch(/promising/);
    expect(body).toMatch(/moderate/);
    expect(body).toMatch(/weak/);
    expect(body).toMatch(/no defensible conversion between upvotes and views/i);
  });

  it("refuses numeric forecasts and subscriber extrapolation", () => {
    const body = potential();
    expect(body).toMatch(/Never emit a view range/i);
    expect(body).toMatch(
      /Subscriber count and public score are not\s+view baselines/i,
    );
  });

  it("requires evidence-backed reasons", () => {
    expect(potential()).toMatch(/one to three short reasons/i);
    expect(read("src/agents/reddit_organic/skills/draft.md")).toMatch(
      /`potential` is mandatory on this block/,
    );
  });

  it("agent.md documents every field the presentation schema requires", () => {
    const agent = read(AGENT);
    for (const field of [
      "reddit_post",
      "subreddit",
      "post_type",
      "image_artifact_id",
      "style",
      "affiliation_disclosure",
      "rule_status",
      "required_flair",
      "potential",
      "confidence",
      "reasons",
    ]) {
      expect(
        agent,
        `agent.md never mentions presentation field ${field}`,
      ).toMatch(field);
    }
  });
});

describe("both Reddit lanes enforce a human-voice quality gate", () => {
  it("rewrites the new post after removing canned and botched text", () => {
    const draft = read("src/agents/reddit_organic/skills/draft.md");
    expect(draft).toMatch(/Human-voice pass/);
    expect(draft).toMatch(/canned openings/);
    expect(draft).toMatch(/repeat, trail off, contradict/i);
  });

  it("names a rival only when the thread asks for options", () => {
    const artifact = read("src/agents/reddit_organic/skills/artifact.md");
    expect(artifact).toMatch(/alternative only when the thread asks for options/);
    expect(artifact).toMatch(/A question about one\s+product names no rival/);
  });

  it("applies the existing answer quality gate to the whole answer kit", () => {
    const artifact = read("src/agents/reddit_organic/skills/artifact.md");
    const kit = read("src/agents/reddit_organic/skills/kit.md");
    expect(artifact).toMatch(/It must not read as AI/);
    expect(artifact).toMatch(/Before you ship/);
    expect(kit).toMatch(/must pass the same .*gates/is);
    expect(kit).not.toMatch(/\[confirm:/i);
  });

  it("continues to post research when the Q&A search is empty", () => {
    const recipe = read(RECIPE);
    const diagnose = read("src/agents/reddit_organic/skills/diagnose.md");
    const rank = read("src/agents/reddit_organic/skills/rank.md");
    expect(recipe).toMatch(/must not end the full run/i);
    expect(diagnose).toMatch(/close the Q&A lane, not the full run/i);
    expect(rank).toMatch(/do not skip the additive post lane/i);
  });

  it("does not invent fixed removal, ban or AI-citation rules", () => {
    const rank = read("src/agents/reddit_organic/skills/rank.md");
    expect(rank).not.toMatch(/removed comment costs a week/i);
    expect(rank).not.toMatch(/ban costs .*permanently/i);
    expect(rank).not.toMatch(/nobody has ever been banned/i);
    expect(rank).not.toMatch(/threads AI engines cite most/i);
  });
});

describe("the capsule follows the product's default model", () => {
  it("agent.md pins no model", () => {
    expect(frontmatter(AGENT)).not.toMatch(/^\s+model:\s*\S/m);
    expect(frontmatter(AGENT)).toMatch(/^\s+model_policy:\s*default/m);
  });

  it("the registry parses it and resolves a model anyway", async () => {
    const { loadGlobalAgentDefinition } =
      await import("@/services/agents/registry");
    const def = loadGlobalAgentDefinition("reddit_organic");
    expect(def).not.toBeNull();
    expect(def!.metadata_praxis.model).toBeTruthy();
  });
});
