
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listAgents } from "@/services/agents/registry";

const AGENT_MD = readFileSync(
  join(__dirname, "..", "agent.md"),
  "utf-8",
);

const WRITE_VERBS = [
  "update", "delete", "set", "create", "insert", "move", "send", "post",
  "patch", "put", "destroy", "approve", "refund", "archive", "assign",
  "resolve", "invite", "submit", "trigger", "sync", "reindex", "publish",
  "merge", "write", "remove", "drop", "revoke", "grant", "ban", "suspend",
  "apply",
  "retire",
];

const EXTERNAL_READ_ALLOW = new Set<string>(["web_search__search"]);

const INTERNAL_WRITE_ALLOW = new Set<string>([
  "praxis__handoff",
  "praxis__action",
  "praxis__propose_standing_order",
  "memory__write",
  "brain__apply_anchor",
  "brain__retire_note",
  "praxis__remind",
  "praxis__list_reminders",
  "praxis__cancel_reminder",
  "x_ads__propose_pause_campaign",
  "x_ads__propose_resume_campaign",
  "x_ads__propose_update_campaign",
  "x_ads__propose_create_campaign",
  "tiktok_ads__propose_status_change",
  "tiktok_ads__propose_budget_change",
]);

const WILDCARD_GRANTS = new Set<string>([
  "composio__*",
]);

const KNOWN_SERVERS = new Set<string>([
  "operator_db", "memory", "slack", "stripe", "email",
  "brain",
  "google_ads", "meta_ads", "github", "jira", "linear", "web_search",
  "web_fetch",
  "apify",
  "praxis",
  "x_ads",
  "tiktok_ads",
  "artifacts",
  "report",
  "code_index",
  "composio",
  "growth",
  "geo",
  "praxis_corpus",
]);

function parseTools(agentMd: string): string[] {
  const lines = agentMd.split("\n");
  const start = lines.findIndex((l) => /^\s*tools:\s*$/.test(l));
  if (start === -1) throw new Error("could not locate tools: block in operator agent.md");
  const baseIndent = lines[start].match(/^\s*/)![0].length;

  const tools: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (line.match(/^\s*/)![0].length <= baseIndent) break;
    const t = line.trim();
    if (t.startsWith("#")) continue;
    if (t.startsWith("- ")) tools.push(t.slice(2).trim());
  }
  return tools;
}

describe("operator agent — frontmatter shape regressions", () => {
  it("manual_only: true (runner refuses otherwise)", () => {
    expect(AGENT_MD).toMatch(/manual_only:\s*true/);
  });
  it("side_effects: true (operator emits decisions via praxis__action — PR #116)", () => {
    expect(AGENT_MD).toMatch(/side_effects:\s*true/);
  });
  it("kill_switch: true (writes routed through tiered-autonomy gate, kill must be honored)", () => {
    expect(AGENT_MD).toMatch(/kill_switch:\s*true/);
  });
  it("decision_class is non-empty (runner.ts:110 safety gate requires this for side_effects:true)", () => {
    expect(AGENT_MD).toMatch(/decision_class:\s*"operator\./);
  });
  it("sla_class: prompt (interactive chat)", () => {
    expect(AGENT_MD).toMatch(/sla_class:\s*prompt/);
  });
  it("output_envelope is NOT set (chat-dispatcher renders plain chat when absent)", () => {
    expect(AGENT_MD).not.toMatch(/^\s*output_envelope:\s*\S/m);
  });
  it("model is claude-sonnet-5-5", () => {
    expect(AGENT_MD).toMatch(/model:\s*claude-sonnet-5-5/);
  });
});

describe("operator agent — tool allow-list regression (CRITICAL, read-only invariant)", () => {
  const tools = parseTools(AGENT_MD);

  it("has at least one tool (otherwise the agent is useless)", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  for (const tool of [
    "operator_db__catalog",
    "operator_db__query_user",
    "memory__search",
  ]) {
    it(`includes core read tool ${tool}`, () => {
      expect(tools).toContain(tool);
    });
  }

  it("Stripe is native only: no Pipedream Stripe grant (Pipedream is not a rail)", () => {
    expect(tools).not.toContain("pipedream_stripe__*");
  });

  it("every tool parses as <server>__<tool> against a known server", () => {
    for (const t of tools) {
      if (t.endsWith("__*")) {
        expect(
          WILDCARD_GRANTS.has(t),
          `new wildcard tool grant "${t}" — a wildcard bypasses the per-tool write-verb scan entirely. Review before adding.`,
        ).toBe(true);
        continue;
      }
      const match = t.match(/^([a-z0-9_]+)__([a-z0-9_]+)$/);
      expect(match, `tool ${t} doesn't match <server>__<tool>`).not.toBeNull();
      const server = match![1];
      expect(KNOWN_SERVERS.has(server), `unknown server_id ${server} in tool ${t}`).toBe(true);
    }
  });

  it("ZERO tools match write-shaped verb patterns (fail-closed)", () => {
    for (const t of tools) {
      const toolPart = t.split("__")[1] ?? "";
      for (const verb of WRITE_VERBS) {
        const re = new RegExp(`(^|_)${verb}(_|$)`, "i");
        if (re.test(toolPart)) {
          if (EXTERNAL_READ_ALLOW.has(t)) continue;
          if (INTERNAL_WRITE_ALLOW.has(t)) continue;
          throw new Error(
            `operator tool "${t}" matches write-shape verb "${verb}". Add to EXTERNAL_READ_ALLOW or INTERNAL_WRITE_ALLOW only after explicit security review.`,
          );
        }
      }
    }
  });
});

describe("operator agent — discovery + parse via registry (T1/T2 verify)", () => {
  it("listAgents() includes operator after agent.md exists on disk", () => {
    const all = listAgents();
    const op = all.find((a) => a.slug === "operator");
    expect(op, "operator not found in listAgents() — agent.md missing or unparseable").toBeDefined();
  });

  it("operator has manual_only=true and side_effects=true in parsed metadata", () => {
    const all = listAgents();
    const op = all.find((a) => a.slug === "operator")!;
    expect(op.metadata_praxis.manual_only).toBe(true);
    expect((op.metadata_praxis as { side_effects?: boolean }).side_effects).toBe(true);
    expect((op.metadata_praxis as { kill_switch?: boolean }).kill_switch).toBe(true);
    expect(op.metadata_praxis.decision_class).toMatch(/^operator\./);
  });

  it("operator has NO output_envelope in parsed metadata (regression: plain chat)", () => {
    const all = listAgents();
    const op = all.find((a) => a.slug === "operator")!;
    expect(op.metadata_praxis.output_envelope).toBeUndefined();
  });
});

describe("operator agent — fixture (test self-test): write-shape tool is correctly flagged", () => {
  it("a synthetic write-shape tool name is caught by the regex", () => {
    const bad = "slack__post_message";
    const toolPart = bad.split("__")[1];
    const verbs = WRITE_VERBS.map((v) => new RegExp(`(^|_)${v}(_|$)`, "i"));
    const matched = verbs.some((re) => re.test(toolPart));
    expect(matched).toBe(true);
  });

  it("a synthetic external-read allowed tool passes", () => {
    const ok = "web_search__search";
    expect(EXTERNAL_READ_ALLOW.has(ok)).toBe(true);
  });
});
