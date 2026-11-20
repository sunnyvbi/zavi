
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { ALLOWED_WRITE_TOOLS } from "@/services/mcp/write-allowlist";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

export const MONEY_WRITE_TOOLS: readonly string[] = [
  "meta_ads_propose_budget_change",
  "meta_ads_propose_status_change",
  "meta_ads_propose_new_ad_set",
  "meta_ads_propose_duplicate",
  "meta_ads_propose_new_ad",
  "meta_ads_propose_custom_audience",
  "google_ads_propose_budget_change",
  "google_ads_propose_status_change",
  "google_ads_propose_new_campaign",
  "google_ads_propose_campaign_update",
  "google_ads_propose_new_ad_group",
  "google_ads_propose_ad_group_update",
  "google_ads_propose_new_ad",
  "google_ads_propose_keywords",
  "google_ads_propose_removal",
  "google_ads_propose_video_campaign",
  "google_ads_propose_video_ad",
  "google_ads_propose_pmax_campaign",
  "reddit_ads_propose_pause_campaign",
  "linkedin_ads_propose_pause_campaign",
  "linkedin_ads_propose_launch_campaign",
  "tiktok_ads_propose_budget_change",
  "tiktok_ads_propose_status_change",
  "tiktok_ads_propose_launch",
  "stripe_create_payment",
  "stripe_remit_to_tenant",
  "stripe_submit_dispute_evidence",
];

const MONEY_WILDCARD_NAMESPACES = ["stripe", "pipedream_stripe", "meta_ads", "google_ads"];

function serverHasAllowlistedWrite(serverId: string): boolean {
  return (ALLOWED_WRITE_TOOLS[serverId]?.size ?? 0) > 0;
}

const norm = (t: string) => t.replace("__", "_");

function agentSlugs(): string[] {
  if (!fs.existsSync(AGENTS_ROOT)) return [];
  return fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "lib")
    .map((d) => d.name)
    .filter((s) => fs.existsSync(path.join(AGENTS_ROOT, s, "agent.md")))
    .sort();
}

type Praxis = {
  tools?: string[];
  capabilities?: { money_path?: boolean };
};

function praxisOf(slug: string): Praxis {
  const raw = fs.readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf-8");
  const fm = matter(raw).data as { metadata?: { praxis?: Praxis } };
  return fm.metadata?.praxis ?? {};
}

function moneyWriteGrants(tools: string[]): string[] {
  const hits: string[] = [];
  for (const t of tools) {
    if (typeof t !== "string") continue;
    if (MONEY_WRITE_TOOLS.includes(norm(t))) {
      hits.push(t);
      continue;
    }
    if (t.endsWith("*")) {
      const ns = t.replace(/__\*$/, "").replace(/_\*$/, "");
      if (MONEY_WILDCARD_NAMESPACES.includes(ns) && serverHasAllowlistedWrite(ns)) {
        hits.push(`${t} (wildcard into a server with executable writes)`);
      }
    }
  }
  return hits;
}

describe("money-path capability lint", () => {
  it("finds the agent fleet on disk (sanity check)", () => {
    expect(agentSlugs().length).toBeGreaterThan(0);
  });

  it("every money-write tool name is a real declared tool", () => {
    const roots = [
      path.join(process.cwd(), "src", "services", "tools"),
      path.join(process.cwd(), "src", "services", "mcp", "internal"),
    ];
    const declared = new Set<string>();
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(full);
        } else if (e.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
          for (const m of fs.readFileSync(full, "utf-8").matchAll(/\bname:\s*"([a-z0-9_]+)"/g)) {
            declared.add(m[1]);
          }
        }
      }
    };
    for (const r of roots) walk(r);
    expect(MONEY_WRITE_TOOLS.filter((t) => !declared.has(t))).toEqual([]);
  });

  const CHAT_PROPOSAL_ONLY: Readonly<Record<string, readonly string[]>> = {
    operator: ["tiktok_ads__propose_budget_change", "tiktok_ads__propose_status_change"],
  };

  it("every agent granted a money-write tool declares capabilities.money_path", () => {
    const bad: string[] = [];
    for (const slug of agentSlugs()) {
      const p = praxisOf(slug);
      const grants = moneyWriteGrants(p.tools ?? []).filter((t) => !(CHAT_PROPOSAL_ONLY[slug] ?? []).includes(t));
      if (grants.length === 0) continue;
      if (p.capabilities?.money_path !== true) {
        bad.push(`${slug} grants ${grants.join(", ")} but does not declare capabilities.money_path: true`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("read-only holders in the same namespaces stay OUT of the firewall", () => {
    if (fs.existsSync(path.join(AGENTS_ROOT, "chief-of-staff", "agent.md"))) {
      expect(moneyWriteGrants(praxisOf("chief-of-staff").tools ?? [])).toEqual([]);
    }
    expect(moneyWriteGrants(praxisOf("operator").tools ?? []).sort()).toEqual([...CHAT_PROPOSAL_ONLY.operator]);
    expect(praxisOf("operator").capabilities?.money_path).not.toBe(true);
  });

  it("the pipedream_stripe exemption rests on a real default-deny, not an assumption", () => {
    expect(serverHasAllowlistedWrite("pipedream_stripe")).toBe(false);
    expect(serverHasAllowlistedWrite("stripe")).toBe(false);
  });

  it("composio wildcard is not money-path: its writes are proposals, never in ALLOWED_WRITE_TOOLS", () => {
    expect(serverHasAllowlistedWrite("composio")).toBe(false);
    expect(moneyWriteGrants(["composio__*"])).toEqual([]);
  });

  it("the lint would CATCH a forgotten flag (falsifier)", () => {
    expect(moneyWriteGrants(["meta_ads__propose_budget_change", "web_search__search"])).toEqual([
      "meta_ads__propose_budget_change",
    ]);
    expect(moneyWriteGrants(["meta_ads__list_campaigns", "stripe__list_charges"])).toEqual([]);
    expect(moneyWriteGrants(["pipedream_stripe__*"])).toEqual([]);
  });
});
