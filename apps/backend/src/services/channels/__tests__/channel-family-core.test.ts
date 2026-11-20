
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { CHANNELS, CHANNEL_CATEGORIES, type ChannelCategory } from "@zavi/shared";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");
const CORE_ROOT = path.join(AGENTS_ROOT, "_core");

const FAMILY_CORE: Record<ChannelCategory, string> = {
  paid: "paid-channel",
  organic: "organic-channel",
  owned: "owned-channel",
  earned: "earned-channel",
  partner: "partner-channel",
};

function perChannelAgents() {
  return CHANNELS.filter((c) => c.executor === c.slug);
}

function inheritsOf(slug: string): string[] {
  const md = path.join(AGENTS_ROOT, slug, "agent.md");
  if (!fs.existsSync(md)) return [];
  const fm = matter(fs.readFileSync(md, "utf-8")).data as {
    metadata?: { praxis?: { inherits?: unknown } };
  };
  const inh = fm.metadata?.praxis?.inherits;
  return Array.isArray(inh) ? inh.map(String) : [];
}

describe("channel family cores", () => {
  it("has a core file for every CHANNEL_CATEGORIES value", () => {
    const missing = CHANNEL_CATEGORIES.filter(
      (cat) => !fs.existsSync(path.join(CORE_ROOT, `${FAMILY_CORE[cat]}.md`)),
    );
    expect(missing, `no _core file for category: ${missing.join(", ")}`).toEqual([]);
  });

  it("maps every category exactly once, with no stale entries", () => {
    expect(Object.keys(FAMILY_CORE).sort()).toEqual([...CHANNEL_CATEGORIES].sort());
    const cores = Object.values(FAMILY_CORE);
    expect(new Set(cores).size).toBe(cores.length);
  });

  it("is not vacuous — at least one channel runs its own agent", () => {
    const own = perChannelAgents();
    expect(
      own.length,
      "no channel has executor === slug; the family-core guard is checking nothing",
    ).toBeGreaterThan(0);
  });

  it("every per-channel agent inherits the core for its category", () => {
    const bad: string[] = [];
    for (const c of perChannelAgents()) {
      const want = FAMILY_CORE[c.category];
      const got = inheritsOf(c.slug);
      if (!fs.existsSync(path.join(AGENTS_ROOT, c.slug, "agent.md"))) {
        bad.push(`${c.slug}: executor is itself but agents/${c.slug}/agent.md does not exist`);
        continue;
      }
      if (!got.includes(want)) {
        bad.push(`${c.slug} (${c.category}) must inherit "${want}" — inherits: [${got.join(", ")}]`);
      }
    }
    expect(
      bad,
      "A channel agent missing its family core operates a real surface without that " +
        "surface's shared discipline. A missing non-baseline core only WARNS at dispatch, " +
        "so nothing else in CI would catch it.\n" + bad.join("\n"),
    ).toEqual([]);
  });

  it("keeps each channel agent body small enough to stay maintainable", () => {
    const CAP_BYTES = 20_000;
    const over: string[] = [];
    for (const c of perChannelAgents()) {
      const md = path.join(AGENTS_ROOT, c.slug, "agent.md");
      if (!fs.existsSync(md)) continue;
      const size = fs.statSync(md).size;
      if (size > CAP_BYTES) {
        over.push(`${c.slug}: ${size} B > ${CAP_BYTES} B — move shared rules into _core/${FAMILY_CORE[c.category]}.md`);
      }
    }
    expect(over, over.join("\n")).toEqual([]);
  });
});
