
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { actionsStoreFor, allowedActionTypes, CHANNELS, type ActionType, type Channel } from "@zavi/shared";
import { deriveActionType, type DerivableStep } from "../action-type";

const WAVE4_UGC = "ugc";

type Fixture = {
  shape: string;
  step: DerivableStep;
  staged?: string | null;
  expected?: ActionType;
  coerced?: boolean;
};

const UGC: Fixture[] = [
  {
    shape: "physical-goods-maker",
    step: { title: "Post this creator job ad to your own customers first", deliverable: { kind: "post" } },
    expected: "send_message",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "DM creators you find by searching for side-hustle content", deliverable: { kind: "dm" } },
    expected: "send_message",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Send the licence terms to the creator before anyone films", deliverable: { kind: "email" } },
    expected: "send_message",
  },
  {
    shape: "team-subscription-tool",
    step: { title: "Optional: test the three hooks this week with a labelled AI draft", deliverable: { kind: "script" } },
    expected: "video_post",
  },
  {
    shape: "paid-community",
    step: { title: "Before you pay, check the delivered video against this list", deliverable: { kind: "list" } },
    expected: "check",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "Watch the delivered video and tick this checklist before paying", deliverable: { kind: "list" } },
    expected: "check",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Post the three takes on your own accounts, eight days apart", deliverable: { kind: "list" } },
    expected: "video_post",
  },
  {
    shape: "booking-led-local-service",
    step: { title: "Post the three hook takes over eight days with tracking links", deliverable: { kind: "list" } },
    expected: "video_post",
  },
  {
    shape: "team-subscription-tool",
    step: { title: "Pull creator candidates on the next run against this brief", deliverable: null },
    expected: "check",
  },
  {
    shape: "paid-community",
    step: { title: "Agree the licence in four named terms before anyone films", deliverable: null },
    expected: "check",
  },
  {
    shape: "physical-goods-maker",
    step: { title: "What a stranger with a phone could actually show working", deliverable: { kind: "brief" } },
    expected: "check",
  },
  {
    shape: "two-sided-marketplace",
    step: { title: "Connect the ad account so the tagged asset can be counted", deliverable: null },
    coerced: true,
  },
  {
    shape: "paid-community",
    step: { title: "The three questions to screen replies with", deliverable: { kind: "list" } },
    coerced: false,
  },
];

describe("wave 4: ugc is switched", () => {
  it("ugc reads and writes channel_actions", () => {
    expect(actionsStoreFor(WAVE4_UGC)).toBe("channel_actions");
  });

  it("youtube_ads switched in wave 7, once its propose tools had a rail", () => {
    expect(actionsStoreFor("youtube_ads")).toBe("channel_actions");
  });
});

describe("ugc: derived type is always one the registry allows", () => {
  it("covers at least 3 different business shapes", () => {
    expect(new Set(UGC.map((f) => f.shape)).size).toBeGreaterThanOrEqual(3);
  });

  it("every fixture derives a type inside this channel's action_types", () => {
    const allowed = allowedActionTypes(WAVE4_UGC);
    expect(allowed.length).toBeGreaterThan(0);
    for (const f of UGC) {
      const { action_type } = deriveActionType(WAVE4_UGC, f.step, f.staged ?? null);
      expect(allowed, `ugc / ${f.shape} / ${String(f.step.title)}`).toContain(action_type);
    }
  });

  it("derives the type each per-channel rule calls for", () => {
    for (const f of UGC) {
      if (!f.expected) continue;
      const { action_type, coerced } = deriveActionType(WAVE4_UGC, f.step, f.staged ?? null);
      expect(action_type, `ugc / ${f.shape} / ${String(f.step.title)}`).toBe(f.expected);
      expect(coerced, `ugc / ${f.shape}: an expected type must not be a coercion`).toBe(false);
    }
  });

  it("a fixture with no expected type falls to `other`, which is always allowed", () => {
    for (const f of UGC) {
      if (f.expected) continue;
      const { action_type, coerced } = deriveActionType(WAVE4_UGC, f.step, f.staged ?? null);
      expect(action_type, `ugc / ${f.shape}`).toBe("other");
      expect(coerced, `ugc / ${f.shape}: whether the fall-through is COUNTED`).toBe(f.coerced);
      expect(allowedActionTypes(WAVE4_UGC)).toContain(action_type);
    }
  });
});

describe("the craft-first branch, in both directions", () => {
  const derive = (slug: string, title: string, kind: string | null) =>
    deriveActionType(slug, { title, deliverable: kind ? { kind } : null }).action_type;

  it("anything published on this channel is a message, whatever kind the model picked", () => {
    for (const kind of ["post", "thread", "comment", "dm", "email"]) {
      expect(derive("ugc", "Post this creator job ad to your own list first", kind), kind).toBe("send_message");
    }
  });

  it("the gate before paying beats the posting plan, though both open on `post`", () => {
    const gate = [
      "Check the delivered video before paying",
      "Before you pay, check the delivered video against this list",
      "Watch the delivered video once before paying, check every box",
      "Watch the delivered video and tick this checklist before paying",
    ];
    for (const t of gate) expect(derive("ugc", t, "list"), t).toBe("check");
  });

  it("the plan for posting the takes is the one card that publishes video", () => {
    const plan = [
      "Post the three takes on your own accounts, 3 days apart",
      "Post all three takes on your own accounts over two weeks",
      "Post the three hook takes on your own accounts over 14 days",
      "Upload the three cuts across the two accounts you already run",
    ];
    for (const t of plan) expect(derive("ugc", t, "list"), t).toBe("video_post");
  });

  it("a plain list that is neither stays `other`, and is NOT counted as a coercion", () => {
    expect(deriveActionType("ugc", { title: "The three screening questions", deliverable: { kind: "list" } })).toEqual({
      action_type: "other",
      coerced: false,
    });
  });

  it("the shapes the generic map already got right are untouched", () => {
    expect(derive("ugc", "Test the three hooks with a labelled AI draft", "script")).toBe("video_post");
    expect(derive("ugc", "What could actually be shown working on camera", "brief")).toBe("check");
    expect(derive("ugc", "The on-screen disclosure line to paste in", "page_copy")).toBe("fix");
    expect(derive("ugc", "Tag the shipped asset before it goes live", null)).toBe("check");
  });

  it("the branch does not reach any other channel", () => {
    expect(derive("x_organic", "Post this creator job ad to your own list", "post")).toBe("text_post");
    expect(derive("tiktok_organic", "Post the three takes over eight days", "list")).toBe("other");
    expect(derive("seo", "Watch the delivered video before paying", "list")).toBe("other");
  });
});

const MIGRATIONS_DIR = path.join(process.cwd(), "..", "..", "supabase", "migrations");

type ArchiveStatement = { file: string; sql: string; slugs: string[] };

function archiveStatements(): ArchiveStatement[] {
  const out: ArchiveStatement[] = [];
  for (const file of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    if (!/channel_action/.test(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").replace(/--[^\n]*/g, "");
    for (const raw of sql.split(";")) {
      const stmt = raw.replace(/\s+/g, " ").trim().toLowerCase();
      if (!/^update decisions\b/.test(stmt)) continue;
      const slugs = new Set<string>();
      for (const m of stmt.matchAll(/r\.channel_slug in \(([^)]*)\)/g)) {
        for (const s of m[1].matchAll(/'([a-z_]+)'/g)) slugs.add(s[1]);
      }
      for (const m of stmt.matchAll(/r\.channel_slug = '([a-z_]+)'/g)) slugs.add(m[1]);
      out.push({ file, sql: stmt, slugs: [...slugs] });
    }
  }
  return out;
}

function archivedSlugs(): Set<string> {
  return new Set(archiveStatements().flatMap((s) => s.slugs));
}

describe("a channel is switched if and only if a migration archived its open cards", () => {
  const switched = (CHANNELS as readonly Channel[])
    .filter((c) => c.actions_store === "channel_actions")
    .map((c) => c.slug)
    .sort();

  it("reads real archive statements off disk, so the scan itself is not vacuous", () => {
    expect(archiveStatements().length).toBeGreaterThanOrEqual(6);
    expect(archivedSlugs().size).toBeGreaterThanOrEqual(11);
  });

  it("every switched channel has an archive statement naming it", () => {
    const archived = archivedSlugs();
    for (const slug of switched) {
      expect(archived, `${slug} is switched with no archive statement: its open cards are stranded`).toContain(slug);
    }
  });

  it("no channel was archived without being switched", () => {
    for (const slug of archivedSlugs()) {
      expect(switched, `${slug} had its cards archived but still serves them from decisions`).toContain(slug);
    }
  });
});

describe("every archive statement is scoped to the rows it means", () => {
  const statements = archiveStatements();

  it("finds every statement, so the checks below have subjects", () => {
    expect(statements.length).toBeGreaterThanOrEqual(8);
  });

  it.each([
    ["archives rather than acts on the row", /set status = 'archived'/],
    ["touches only still-open cards", /d\.status = 'proposed'/],
    ["constrains the class rather than closing every card", /d\.decision_class (?:=|like) '/],
    ["correlates the card to its run", /r\.id = d\.agent_run_id/],
    ["correlates the run to the SAME tenant", /r\.tenant_id = d\.tenant_id/],
    ["names the channel, so it cannot close every channel at once", /r\.channel_slug/],
  ])("%s", (_what, predicate) => {
    for (const s of statements) {
      expect(s.sql, `${s.file}: missing ${String(predicate)}`).toMatch(predicate);
    }
  });

  it("constrains the class to a shape this test knows", () => {
    const known = [
      /d\.decision_class = 'channel\.recipe_step'/,
      /d\.decision_class like 'google\\_ads\.%'/,
      /d\.decision_class like 'meta\\_ads\.%'/,
    ];
    for (const s of statements) {
      expect(
        known.some((k) => k.test(s.sql)),
        `${s.file}: archives a decision_class shape nothing here has read — add it deliberately or narrow the statement`,
      ).toBe(true);
    }
  });

  it("the per-wave migrations archive recipe steps specifically", () => {
    const wave = statements.filter((s) => /_wave\d.*_archive\.sql$/.test(s.file));
    expect(wave.length).toBeGreaterThanOrEqual(6);
    for (const s of wave) {
      expect(s.sql, `${s.file} is a wave migration that archives some other class`).toMatch(
        /d\.decision_class = 'channel\.recipe_step'/,
      );
    }
  });

  it("never stamps dispatched_at, which the ads cap-readers aggregate", () => {
    for (const s of statements) {
      expect(s.sql, `${s.file} writes a money-path timestamp`).not.toMatch(/dispatched_at/);
      expect(s.sql, `${s.file} closes rows as done, not archived`).not.toMatch(/status = 'acted'/);
    }
  });
});
