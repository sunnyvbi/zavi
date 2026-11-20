import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(
  join(migrationsDir, "20260707200000_generalized_decision_target_key_dedup.sql"),
  "utf-8",
);
const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260707200000 — registry columns", () => {
  it("adds single_open_per_target (default false) + target_key_paths to decision_classes", () => {
    expect(ddl).toMatch(
      /alter table decision_classes\s+add column if not exists single_open_per_target boolean not null default false/i,
    );
    expect(ddl).toMatch(
      /alter table decision_classes\s+add column if not exists target_key_paths text\[\]/i,
    );
  });
});

describe("20260707200000 — decision_target_key helper", () => {
  it("is a pure/immutable SQL fn with locked search_path", () => {
    expect(ddl).toMatch(
      /create or replace function decision_target_key\(p_body jsonb, p_paths text\[\]\)\s+returns text\s+language sql\s+immutable\s+set search_path = public/i,
    );
  });
  it("returns NULL when the primary discriminator (first path) is absent/empty", () => {
    expect(ddl).toMatch(/when nullif\(p_body ->> p_paths\[1\], ''\) is null then null/i);
  });
  it("composes the key by chr(31)-joining coalesce('') of each path in order", () => {
    expect(ddl).toMatch(
      /string_agg\(coalesce\(p_body ->> k, ''\), chr\(31\) order by ord\)/i,
    );
    expect(ddl).toMatch(/from unnest\(p_paths\) with ordinality/i);
  });
});

describe("20260707200000 — generalized target supersede in emit_decision", () => {
  it("recreates the 5-arg emit_decision (autonomy_override signature preserved)", () => {
    expect(ddl).toMatch(
      /create or replace function emit_decision\(\s*p_tenant_id uuid,\s*p_agent_run_id uuid,\s*p_decision_class text,\s*p_body jsonb,\s*p_autonomy_override decision_autonomy default null/i,
    );
    expect(ddl).toMatch(/language plpgsql security definer set search_path = public/i);
  });

  it("reads the per-class config (single_open_per_target + target_key_paths) from decision_classes", () => {
    expect(ddl).toMatch(
      /select dispatch_handler, single_open_per_target, target_key_paths\s+into v_handler, v_single_open, v_target_paths\s+from decision_classes where slug = p_decision_class/i,
    );
  });

  it("gates the generalized supersede on non-meta_ads AND coalesce(v_single_open,false)", () => {
    expect(ddl).toMatch(
      /if v_status = 'proposed' and not v_is_meta_ads and coalesce\(v_single_open, false\) then/i,
    );
  });

  it("supersedes older open proposed rows whose derived target equals the new one", () => {
    const block = ddl.slice(ddl.indexOf("coalesce(v_single_open, false)"));
    expect(block).toMatch(/set status = 'superseded'/i);
    expect(block).toMatch(/superseded_by = v_id/i);
    expect(block).toMatch(/decision_target_key\(d\.body, v_target_paths\) = v_target/i);
    expect(block).toMatch(/and d\.status = 'proposed'/i);
    expect(block).toMatch(/and d\.id <> v_id/i);
  });

  it("scopes the supersede to the same tenant (no cross-tenant collapse)", () => {
    const block = ddl.slice(ddl.indexOf("coalesce(v_single_open, false)"));
    expect(block).toMatch(/where d\.tenant_id = p_tenant_id/i);
  });

  it("computes the new row's target via decision_target_key(p_body, v_target_paths) and skips on NULL", () => {
    expect(ddl).toMatch(/v_target := decision_target_key\(p_body, v_target_paths\);/i);
    const block = ddl.slice(ddl.indexOf("v_target := decision_target_key(p_body, v_target_paths)"));
    expect(block).toMatch(/if v_target is not null then/i);
  });

  it("places the generalized block AFTER the insert (v_id is the superseded_by pointer)", () => {
    const insertIdx = ddl.indexOf("insert into decisions (");
    const genIdx = ddl.indexOf("coalesce(v_single_open, false)");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(insertIdx);
  });
});

describe("20260707200000 — meta_ads bespoke block preserved (no regression)", () => {
  it("keeps the meta_ads COALESCE(object_id|ad_set_id|campaign_id+name) supersede verbatim", () => {
    expect(ddl).toMatch(/if v_status = 'proposed' and v_is_meta_ads then/i);
    expect(ddl).toMatch(
      /coalesce\(\s*p_body->>'object_id',\s*p_body->>'ad_set_id',\s*\(p_body->>'campaign_id'\) \|\| '\|' \|\| coalesce\(p_body->>'name', ''\)\s*\)/i,
    );
  });
  it("keeps the non-meta_ads content-fingerprint keep-existing dedup (advisory lock + return existing id)", () => {
    expect(ddl).toMatch(/pg_advisory_xact_lock/i);
    expect(ddl).toMatch(/decision_content_fingerprint\(d\.body\) = v_fingerprint/i);
  });
  it("keeps the tighten-only autonomy override + kill-switch short-circuit", () => {
    expect(ddl).toMatch(/p_decision_class = 'engineer\.ship-pr'\s*and v_autonomy = 'auto'\s*and p_autonomy_override = 'approval'/i);
    expect(ddl).toMatch(/dispatch_error\s*\) values \(\s*p_tenant_id, p_agent_run_id, p_decision_class, p_body, 'rejected',\s*'forbidden', null, 'kill_switch'/i);
  });
});

describe("20260707200000 — conservative reversible seed only", () => {
  it("seeds ONLY the two reversible operator issue-filing classes", () => {
    expect(ddl).toMatch(
      /update decision_classes\s+set single_open_per_target = true,\s+target_key_paths = array\['project_key', 'summary'\]\s+where slug = 'operator\.file-jira-issue'/i,
    );
    expect(ddl).toMatch(
      /update decision_classes\s+set single_open_per_target = true,\s+target_key_paths = array\['team_id', 'title'\]\s+where slug = 'operator\.file-linear-issue'/i,
    );
  });
  it("does NOT seed any money-moving / irreversible / E3 class", () => {
    expect(ddl).not.toMatch(/single_open_per_target = true[\s\S]*?where slug = 'growth-lead\.reallocate-budget'/i);
    expect(ddl).not.toMatch(/single_open_per_target = true[\s\S]*?where slug = 'stripe\./i);
    expect(ddl).not.toMatch(/single_open_per_target = true[\s\S]*?where slug = 'refund_stripe'/i);
    expect(ddl).not.toMatch(/single_open_per_target = true[\s\S]*?where slug = 'dispute-response\./i);
    expect(ddl).not.toMatch(/single_open_per_target = true[\s\S]*?where slug = 'ban_user'/i);
  });
  it("backfill collapses existing dup piles ONLY for the two seeded classes", () => {
    expect(ddl).toMatch(
      /and d\.decision_class in \('operator\.file-jira-issue', 'operator\.file-linear-issue'\)/i,
    );
  });
});

const US = "";

function deriveTargetKey(
  body: Record<string, unknown>,
  paths: string[] | null,
): string | null {
  if (!paths || paths.length === 0) return null;
  const primary = body[paths[0]];
  if (primary == null || String(primary) === "") return null;
  return paths.map((k) => (body[k] == null ? "" : String(body[k]))).join(US);
}

type Card = {
  id: number;
  tenant: string;
  cls: string;
  body: Record<string, unknown>;
  status: "proposed" | "superseded";
};
type ClassCfg = { singleOpen: boolean; paths: string[] | null };

let seq = 0;
function simulateEmit(
  cards: Card[],
  cfg: Record<string, ClassCfg>,
  tenant: string,
  cls: string,
  body: Record<string, unknown>,
): number {
  const c = cfg[cls] ?? { singleOpen: false, paths: null };
  const fp = JSON.stringify(body);
  const existing = cards.find(
    (d) =>
      d.tenant === tenant &&
      d.cls === cls &&
      d.status === "proposed" &&
      JSON.stringify(d.body) === fp,
  );
  if (existing) return existing.id;
  const id = ++seq;
  cards.push({ id, tenant, cls, body, status: "proposed" });
  if (c.singleOpen) {
    const target = deriveTargetKey(body, c.paths);
    if (target != null) {
      for (const d of cards) {
        if (
          d.tenant === tenant &&
          d.cls === cls &&
          d.status === "proposed" &&
          d.id !== id &&
          deriveTargetKey(d.body, c.paths) === target
        ) {
          d.status = "superseded";
        }
      }
    }
  }
  return id;
}

const openCards = (cards: Card[], tenant: string, cls: string) =>
  cards.filter((d) => d.tenant === tenant && d.cls === cls && d.status === "proposed");

describe("Move E5 semantics — the four required scenarios", () => {
  const cfg: Record<string, ClassCfg> = {
    "operator.file-jira-issue": { singleOpen: true, paths: ["project_key", "summary"] },
    "post_slack_message": { singleOpen: false, paths: null },
  };

  it("two re-decides on the SAME target (drifted body) → ONE open card", () => {
    const cards: Card[] = [];
    simulateEmit(cards, cfg, "t1", "operator.file-jira-issue", {
      project_key: "SCRUM",
      summary: "Fix login 500",
      description_markdown: "first pass reasoning",
    });
    simulateEmit(cards, cfg, "t1", "operator.file-jira-issue", {
      project_key: "SCRUM",
      summary: "Fix login 500",
      description_markdown: "SECOND run — reasoning drifted, same issue",
    });
    const open = openCards(cards, "t1", "operator.file-jira-issue");
    expect(open).toHaveLength(1);
    expect(open[0].body.description_markdown).toMatch(/SECOND run/);
  });

  it("two DIFFERENT targets → TWO open cards", () => {
    const cards: Card[] = [];
    simulateEmit(cards, cfg, "t1", "operator.file-jira-issue", {
      project_key: "SCRUM",
      summary: "Fix login 500",
    });
    simulateEmit(cards, cfg, "t1", "operator.file-jira-issue", {
      project_key: "SCRUM",
      summary: "Add rate limiting",
    });
    expect(openCards(cards, "t1", "operator.file-jira-issue")).toHaveLength(2);
  });

  it("non-single-open class → UNCHANGED (distinct cards, no collapse)", () => {
    const cards: Card[] = [];
    simulateEmit(cards, cfg, "t1", "post_slack_message", { channel_id: "C1", text: "a" });
    simulateEmit(cards, cfg, "t1", "post_slack_message", { channel_id: "C1", text: "b" });
    expect(openCards(cards, "t1", "post_slack_message")).toHaveLength(2);
  });

  it("SAME target across two tenants → NO cross-tenant collapse (two cards)", () => {
    const cards: Card[] = [];
    const body = { project_key: "SCRUM", summary: "Fix login 500" };
    simulateEmit(cards, cfg, "t1", "operator.file-jira-issue", { ...body });
    simulateEmit(cards, cfg, "t2", "operator.file-jira-issue", { ...body });
    expect(openCards(cards, "t1", "operator.file-jira-issue")).toHaveLength(1);
    expect(openCards(cards, "t2", "operator.file-jira-issue")).toHaveLength(1);
  });

  it("target key is NULL-safe: primary path absent → no dedup (skip, never wrong collapse)", () => {
    expect(deriveTargetKey({ summary: "x" }, ["project_key", "summary"])).toBeNull();
    expect(deriveTargetKey({ project_key: "", summary: "x" }, ["project_key", "summary"])).toBeNull();
    expect(deriveTargetKey({ project_key: "SCRUM", summary: "x" }, ["project_key", "summary"])).toBe(
      `SCRUM${US}x`,
    );
  });
});
