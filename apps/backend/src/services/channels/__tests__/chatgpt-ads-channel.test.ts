
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { CHANNELS } from "@zavi/shared";
import { loadChannelRecipe } from "../recipe";

const BACKEND = process.cwd();
const REPO = path.join(BACKEND, "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(...p), "utf-8");

const AGENT_DIR = path.join(BACKEND, "src", "agents", "chatgpt_ads");
const RECIPE_PATH = path.join(BACKEND, "src", "channels", "chatgpt_ads", "recipe.md");
const SKILLS = ["diagnose", "rank", "artifact"] as const;

function quotedSlugs(src: string): string[] {
  return [...src.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]).sort();
}

describe("chatgpt_ads paste rail: one provider list in three places", () => {
  it("the backend tool enum, the web paste box and the submit RPC all accept chatgpt_ads, and agree", () => {
    const tool = read(BACKEND, "src", "services", "tools", "paid-acquisition", "get_latest_snapshot.ts");
    const enumSrc = tool.match(/provider:\s*z\.enum\(\[([^\]]*)\]\)/)?.[1];
    expect(enumSrc, "provider z.enum not found").toBeDefined();
    const backend = quotedSlugs(enumSrc!);

    const paste = read(REPO, "apps", "web", "src", "components", "workspace", "layout", "ChannelSnapshotPaste.tsx");
    const pasteSrc = paste.match(/const PASTEABLE = new Set\(\[([^\]]*)\]\)/)?.[1];
    expect(pasteSrc, "PASTEABLE set not found").toBeDefined();
    const web = quotedSlugs(pasteSrc!);

    const migDir = path.join(REPO, "supabase", "migrations");
    const defining = fs
      .readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /create or replace function submit_ad_snapshot\(/.test(read(migDir, f)))
      .sort();
    const latest = read(migDir, defining.at(-1)!);
    const sqlSrc = latest.match(/p_provider not in \(([^)]*)\)/)?.[1];
    expect(sqlSrc, "submit_ad_snapshot provider allowlist not found").toBeDefined();
    const sql = quotedSlugs(sqlSrc!);

    expect(backend).toContain("chatgpt_ads");
    expect(web).toEqual(backend);
    expect(sql).toEqual(backend);
  });
});

describe("chatgpt_ads registry row and recipe shape", () => {
  const channel = CHANNELS.find((c) => c.slug === "chatgpt_ads");
  const recipe = loadChannelRecipe("chatgpt_ads");
  const steps = recipe.meta.router;

  it("is a paid, connector-less channel carrying evidence and approval-only proposals", () => {
    expect(channel).toBeDefined();
    expect(channel!.category).toBe("paid");
    expect(channel!.readiness).toBe("live");
    expect(channel!.connectors).toEqual([]);
    expect(channel!.tools).toEqual([
      "chatgpt_ads_read_performance",
      "chatgpt_ads_propose_new_campaign",
      "chatgpt_ads_propose_budget_change",
      "chatgpt_ads_propose_status",
      "paid_acquisition_get_latest_snapshot",
    ]);
  });

  it("runs on demand only", () => {
    expect(recipe.meta.cadence).toBe("on_demand");
  });

  it("reads the snapshot exactly once, as the first step, on an `always` step", () => {
    const withSnapshot = steps.filter((s) => s.tools.includes("paid_acquisition__get_latest_snapshot"));
    expect(withSnapshot.map((s) => s.id)).toEqual(["evidence_source"]);
    expect(steps[0].id).toBe("evidence_source");
    expect(steps[0].when).toBe("always");
  });

  it("reads the live account exactly once, on that same first step, BEFORE the paste", () => {
    const withLive = steps.filter((s) => s.tools.includes("chatgpt_ads__read_performance"));
    expect(withLive.map((s) => s.id)).toEqual(["evidence_source"]);
    const tools = steps[0].tools;
    expect(tools.indexOf("chatgpt_ads__read_performance")).toBeLessThan(
      tools.indexOf("paid_acquisition__get_latest_snapshot"),
    );
    expect(steps[0].goal).toMatch(/FIRST/);
  });

  it("the tool that can see a SHARED ad account is granted to this executor and nobody else", () => {
    const agentsRoot = path.join(BACKEND, "src", "agents");
    const holders = fs
      .readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(agentsRoot, d.name, "agent.md")))
      .filter((d) => {
        const fm = matter(read(agentsRoot, d.name, "agent.md")).data as {
          metadata?: { praxis?: { tools?: string[] } };
        };
        return (fm.metadata?.praxis?.tools ?? []).includes("chatgpt_ads__read_performance");
      })
      .map((d) => d.name);
    expect(holders).toEqual(["chatgpt_ads"]);
  });

  it("the paste diagnosis holds no tool, so it can only use the one snapshot read", () => {
    const paste = steps.find((s) => s.id === "paste_diagnosis");
    expect(paste).toBeDefined();
    expect(paste!.tools).toEqual([]);
  });

  it("the three eligibility rows are always attempted, and no step is connector-gated", () => {
    for (const id of ["policy_category", "country_availability", "adsbot_crawl"]) {
      expect(steps.find((s) => s.id === id)?.when, id).toBe("always");
    }
    expect(steps.filter((s) => s.when === "connected")).toEqual([]);
  });

  it("card images go through report__generate_image, and the kit step still ships a labelled draft", () => {
    expect(steps.find((s) => s.id === "card_images")?.tools).toEqual(["report__generate_image"]);
    const kit = steps.find((s) => s.id === "ad_kit");
    expect(kit?.goal).toMatch(/labelled draft/);
  });

  it("the executor is granted every tool a router step names", () => {
    const fm = matter(read(AGENT_DIR, "agent.md")).data as {
      metadata?: { praxis?: { tools?: string[] } };
    };
    const granted = new Set(fm.metadata?.praxis?.tools ?? []);
    const missing = [...new Set(steps.flatMap((s) => s.tools))].filter((t) => !granted.has(t));
    expect(missing).toEqual([]);
  });
});

describe("chatgpt_ads prompt text", () => {
  const files: Record<string, string> = {
    "recipe.md": read(RECIPE_PATH),
    "agent.md": read(AGENT_DIR, "agent.md"),
    ...Object.fromEntries(SKILLS.map((s) => [`skills/${s}.md`, read(AGENT_DIR, "skills", `${s}.md`)])),
  };
  const all = Object.values(files).join("\n");

  it("carries no benchmark-shaped number: no dollar figure and no percentage", () => {
    const bad: string[] = [];
    for (const [name, text] of Object.entries(files)) {
      for (const m of text.matchAll(/\$\s?\d|\d(?:\.\d+)?\s?%/g)) bad.push(`${name}: "${m[0]}"`);
    }
    expect(bad).toEqual([]);
  });

  it("contains no em-dash, so no example ad copy can teach one", () => {
    const bad = Object.entries(files)
      .filter(([, text]) => text.includes("—"))
      .map(([name]) => name);
    expect(bad).toEqual([]);
  });

  it("names no dogfood tenant or its vertical", () => {
    expect(all).not.toMatch(/upcar|apna|tutor|rental|\bp2p\b/i);
  });

  it("still states the rules the channel's honesty depends on", () => {
    expect(files["skills/diagnose.md"]).toMatch(/A failed read is `unverified`, never the pass word/);
    expect(files["agent.md"]).toMatch(/ONLY from a read made this\s+run/);
    expect(files["skills/artifact.md"]).toMatch(/OpenAI's policy disallows this category\. OpenAI will reject these ads\./);
    expect(files["skills/artifact.md"]).toMatch(/\| Never \|/);
    expect(files["skills/artifact.md"]).toMatch(/title is [\s\S]{0,40}characters and the body at most/);
    expect(files["skills/artifact.md"]).toMatch(/blank: set from your target\s+cost per customer/);
    expect(files["skills/diagnose.md"]).toMatch(/Never a price from memory/);
    expect(files["skills/diagnose.md"]).toMatch(/Diagnose only those/);
    expect(files["skills/diagnose.md"]).toMatch(/from your ChatGPT Ads account/);
    expect(files["skills/diagnose.md"]).toMatch(/from the snapshot you pasted/);
    expect(files["skills/diagnose.md"]).toMatch(/Never merge the two sources/);
    expect(files["agent.md"]).toMatch(/no_campaigns_for_tenant/);
    expect(files["recipe.md"]).toMatch(/different sentences/);
  });
});

describe("managed first-use workflow", () => {
  const recipe = loadChannelRecipe("chatgpt_ads");
  const agent = read(AGENT_DIR, "agent.md");
  it("starts onboarding only after a verified empty live campaign read", () => {
    expect(recipe.meta.router[0].goal).toContain("Verified no_campaigns_for_tenant starts onboarding");
    expect(recipe.meta.router[0].goal).toContain("errors mean unknown");
    expect(recipe.meta.router[0].goal).toContain("only on explicit historical-comparison requests");
  });
  it("keeps first campaign creation in Zavi and operator-controlled", () => {
    expect(agent).toContain("Under paid delegation, lead with a complete executable proposal");
    expect(agent).toContain("Use the proposal tools for complete executable campaigns");
    expect(agent).toContain("Review and create collects them");
    expect(agent).toContain("five strongest distinct, evidence-backed next actions");
    expect(agent).toContain("Existing paused");
    expect(agent).toContain("Deposits are not ad spend or AI credits");
  });
  it("separates account access from client brand approval", () => {
    expect(agent).toContain("An active account is");
    expect(agent).toContain("not proof its brand review is approved");
    expect(agent).toContain("never propose changing a shared account's brand");
  });
});
