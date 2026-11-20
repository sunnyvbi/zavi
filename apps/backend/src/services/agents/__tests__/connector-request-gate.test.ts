
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  loadAgent: vi.fn(),
  productUrl: null as unknown,
  githubRows: [] as Array<{ slug: string; account_login: string | null }>,
  blob: {} as Record<string, unknown>,
}));

vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: mocks.loadAgent }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => {
      if (t === "tenants") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { product_url: mocks.productUrl }, error: null }) }),
          }),
        };
      }
      if (t === "connector_metadata") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({ data: mocks.githubRows, error: null }),
              in: async (_c: string, slugs: string[]) => ({
                data: mocks.githubRows.filter((r) => slugs.includes(r.slug)),
                error: null,
              }),
            }),
          }),
        };
      }
      if (t === "system_config") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { blob: mocks.blob }, error: null }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${t}`);
    },
  }),
}));

import { firstMissingChatConnector, isOwnSiteUrl, hasOwnGithubRow } from "../setup-schema";
import { connectGateSlugFor, isInfoAsk } from "../connect-gate";

const okProbe = {
  ok: true,
  missing_vault_keys: [],
  missing_connectors: [],
  missing_required_connectors: [],
  missing_optional_connectors: [],
};

beforeEach(() => {
  mocks.loadAgent.mockReset();
  mocks.loadAgent.mockResolvedValue({
    metadata_praxis: { tools: ["github__read_file"], setup: { optional_connectors: ["jira"] } },
  });
  mocks.productUrl = null;
  mocks.githubRows = [];
  mocks.blob = {};
});

describe("firstMissingChatConnector", () => {
  it("own external site + only the umbrella github row → asks for github", async () => {
    mocks.productUrl = { marketing: "https://acme.com" };
    mocks.githubRows = [{ slug: "github", account_login: "Praxis-build" }];
    expect(await firstMissingChatConnector("t1", "engineer", okProbe)).toBe("github");
  });

  it("own external site + no github row at all → asks for github", async () => {
    mocks.productUrl = { marketing: "https://acme.com" };
    const probe = { ...okProbe, ok: false, missing_required_connectors: ["github"], missing_connectors: ["github"] };
    expect(await firstMissingChatConnector("t1", "engineer", probe)).toBe("github");
  });

  it("own external site + their own github install → no ask", async () => {
    mocks.productUrl = { marketing: "https://acme.com" };
    mocks.githubRows = [
      { slug: "github", account_login: "Praxis-build" },
      { slug: "github", account_login: "acme-inc" },
    ];
    expect(await firstMissingChatConnector("t1", "engineer", okProbe)).toBeNull();
  });

  it("Zavi-hosted site with only the umbrella row counts as connected → no ask", async () => {
    mocks.productUrl = { marketing: "https://acme-app.onrender.com" };
    mocks.githubRows = [{ slug: "github", account_login: "Praxis-build" }];
    expect(await firstMissingChatConnector("t1", "engineer", okProbe)).toBeNull();
  });

  it("no site set + no github row → no ask (keeps today's behaviour)", async () => {
    const probe = { ...okProbe, ok: false, missing_required_connectors: ["github"], missing_connectors: ["github"] };
    expect(await firstMissingChatConnector("t1", "engineer", probe)).toBeNull();
  });

  it("an agent whose github is not required is never asked for it", async () => {
    mocks.loadAgent.mockResolvedValue({ metadata_praxis: { tools: ["email__send"] } });
    mocks.productUrl = { marketing: "https://acme.com" };
    expect(await firstMissingChatConnector("t1", "growth-lead", okProbe)).toBeNull();
  });
});

describe("isOwnSiteUrl / hasOwnGithubRow", () => {
  it("matches the web predicates", () => {
    expect(isOwnSiteUrl("https://acme.com")).toBe(true);
    expect(isOwnSiteUrl("https://x.zaviagent.com")).toBe(false);
    expect(isOwnSiteUrl("not a url")).toBe(false);
    expect(isOwnSiteUrl(undefined)).toBe(false);
    expect(hasOwnGithubRow([{ slug: "github", account_login: "Praxis-build" }])).toBe(false);
    expect(hasOwnGithubRow([{ slug: "github", account_login: "me" }])).toBe(true);
  });
});

describe("gate flag placement", () => {
  const agentsDir = join(__dirname, "../../../agents");
  it("only engineer declares setup.chat_requires_connect (growth-lead keeps degrading)", () => {
    expect(readFileSync(join(agentsDir, "engineer/agent.md"), "utf8")).toMatch(/chat_requires_connect: true/);
    expect(readFileSync(join(agentsDir, "growth-lead/agent.md"), "utf8")).not.toMatch(/chat_requires_connect/);
  });

  it("the dispatcher gate runs before the setup ok-check and reads the flag", () => {
    const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf8");
    const gate = src.indexOf("setup?.chat_requires_connect === true");
    const okCheck = src.indexOf("if (!setupProbe.ok) {");
    expect(gate).toBeGreaterThan(0);
    expect(okCheck).toBeGreaterThan(gate);
    expect(src.slice(gate, okCheck)).toMatch(/origin: "gate"[\s\S]*connector_request: emitted\.request/);
  });
});

describe("connectGateSlugFor — the predicate chat-send / runner / run-agent defer on", () => {
  const engineer = { slug: "engineer", metadata_praxis: { setup: { chat_requires_connect: true } } };
  it("switch ON + own site + no github → github (chat-send lets the run be created)", async () => {
    mocks.productUrl = { marketing: "https://acme.com" };
    expect(await connectGateSlugFor({ tenant_id: "t1", agent: engineer, trigger: "chat" })).toBe("github");
  });
  it("a read-only question is answered, never carded; a change ask still gates", async () => {
    mocks.productUrl = { marketing: "https://acme.com" };
    const info = "What does the footer on my homepage say?";
    const change = "Fix the footer on my homepage";
    expect(isInfoAsk({}, info)).toBe(true);
    expect(isInfoAsk({}, "Check the footer and make it blue")).toBe(false);
    expect(isInfoAsk({}, "Show me the footer fixed on mobile")).toBe(false);
    expect(isInfoAsk({}, "Can you show the header redesigned?")).toBe(false);
    expect(isInfoAsk({ cto_chat_intent: "info", task_description: "Check the footer and make it blue" })).toBe(false);
    expect(await connectGateSlugFor({ tenant_id: "t1", agent: engineer, trigger: "chat", text: info })).toBeNull();
    expect(
      await connectGateSlugFor({ tenant_id: "t1", agent: engineer, trigger: "chat", payload: { task_description: info } }),
    ).toBeNull();
    expect(await connectGateSlugFor({ tenant_id: "t1", agent: engineer, trigger: "chat", text: change })).toBe("github");
  });

  it("the dispatcher gate skips read-only asks too", () => {
    const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf8");
    expect(src).toMatch(/chat_requires_connect === true &&[\s\S]{0,200}!isInfoAsk\(payload\)/);
  });

  it("switch OFF → null (chat-send keeps the old repo_access_blocked bubble)", async () => {
    mocks.productUrl = { marketing: "https://acme.com" };
    mocks.blob = { connector_request_enabled: false };
    expect(await connectGateSlugFor({ tenant_id: "t1", agent: engineer, trigger: "chat" })).toBeNull();
  });
  it("no flag, cron trigger, or a provisioned build node → null", async () => {
    mocks.productUrl = { marketing: "https://acme.com" };
    const plain = { slug: "engineer", metadata_praxis: { setup: {} } };
    expect(await connectGateSlugFor({ tenant_id: "t1", agent: plain, trigger: "chat" })).toBeNull();
    expect(await connectGateSlugFor({ tenant_id: "t1", agent: engineer, trigger: "cron" })).toBeNull();
    const build = { stage: "build", target: { github_full_name: "Praxis-build/app" } };
    expect(await connectGateSlugFor({ tenant_id: "t1", agent: engineer, trigger: "chat", payload: build })).toBeNull();
  });
});

describe("doors that used to stop the run before the gate (source)", () => {
  const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
  it("chat-send: the repo_access_blocked bubble is skipped only for not_connected + a firing gate", () => {
    const src = read("../../../routes/agents/chat-send.ts");
    expect(src).toMatch(
      /repoAccess === "not_connected" &&\s*\(await connectGateSlugFor\([\s\S]{0,200}text: body\.message,[\s\S]{0,40}\)\) !== null;\s*if \(repoAccess !== "ok" && !deferToConnectGate\)/,
    );
  });
  it("runner enqueue (Slack): SandboxRepoAccessRequiredError is not thrown when the gate fires", () => {
    const src = read("../runner.ts");
    expect(src).toMatch(/deferToConnectGate[\s\S]{0,400}if \(repoAccess !== "ok" && !deferToConnectGate\)/);
  });
  it("run-agent: eager sandbox provisioning is skipped when the gate fires", () => {
    const src = read("../../../../workers/functions/run-agent.ts");
    expect(src).toMatch(/requires_sandbox && !lazySandboxEligible && !deferToConnectGate/);
  });
});
