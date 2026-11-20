import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PLAYBOOKS, getPlaybook } from "../index";
import { AGENT_TRIGGERS } from "../../services/agents/types";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const AGENTS_DIR = join(__dirname, "..", "..", "agents");

function latestTriggerConstraintList(): Set<string> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let latest: Set<string> | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    const m = sql.match(/agent_runs_trigger_check[\s\S]*?check \(trigger in \(([^)]*)\)\)/i);
    if (m) {
      latest = new Set(
        m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")),
      );
    }
  }
  return latest ?? new Set();
}

function knownDecisionClasses(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const mm of sql.matchAll(/'([a-z][a-z0-9_]*\.[a-z0-9_]+)'/g)) out.add(mm[1]);
  }
  return out;
}

describe("playbook registry", () => {
  it("'playbook' trigger is in AGENT_TRIGGERS AND admitted by the DB constraint", () => {
    expect(AGENT_TRIGGERS).toContain("playbook");
    const allowed = latestTriggerConstraintList();
    expect(allowed.size).toBeGreaterThan(0);
    for (const t of AGENT_TRIGGERS) {
      expect(allowed.has(t)).toBe(true);
    }
  });

  it("every playbook is structurally valid", () => {
    expect(PLAYBOOKS.length).toBeGreaterThanOrEqual(2);
    const slugs = new Set<string>();
    for (const p of PLAYBOOKS) {
      expect(p.slug).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(slugs.has(p.slug)).toBe(false);
      slugs.add(p.slug);
      expect(p.trigger).toBe("playbook");
      expect(p.surface_kind).toBe("playbook_card");
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.outcome.length).toBeGreaterThan(0);
      expect(p.est_credits).toBeGreaterThan(0);
      expect(p.allowed_decision_classes.length).toBeGreaterThan(0);
      expect(p.needs_approval.length).toBeGreaterThan(0);
    }
  });

  it("every playbook's agent_slug is a real agent", () => {
    for (const p of PLAYBOOKS) {
      expect(existsSync(join(AGENTS_DIR, p.agent_slug, "agent.md"))).toBe(true);
    }
  });

  it("every playbook's decision classes are real + approval-gated (no *_auto / *_status without review)", () => {
    const known = knownDecisionClasses();
    for (const p of PLAYBOOKS) {
      for (const cls of p.allowed_decision_classes) {
        expect(known.has(cls), `decision_class '${cls}' (playbook ${p.slug}) must exist in a migration`).toBe(true);
        if (cls.startsWith("meta_ads.")) {
          expect(cls.endsWith("_review"), `${cls} must be the approval (_review) variant`).toBe(true);
        }
      }
    }
  });

  it("every playbook's agent actually OWNS a propose-tool for each decision class (no mis-wire)", () => {
    for (const p of PLAYBOOKS) {
      const md = readFileSync(join(AGENTS_DIR, p.agent_slug, "agent.md"), "utf8");
      for (const cls of p.allowed_decision_classes) {
        const ns = cls.split(".")[0];
        const re = new RegExp(`${ns}__propose`, "i");
        expect(
          re.test(md),
          `playbook '${p.slug}': agent '${p.agent_slug}' declares no '${ns}__propose*' tool to emit '${cls}'`,
        ).toBe(true);
      }
    }
  });

  it("getPlaybook resolves by slug", () => {
    expect(getPlaybook("recover-stalled-sellers")?.agent_slug).toBe("chief-of-staff");
    expect(getPlaybook("campaigns-over-cac")?.agent_slug).toBe("performance-marketer");
    expect(getPlaybook("nope")).toBeUndefined();
  });
});
