import { describe, it, expect, vi, beforeEach } from "vitest";

const ZAVI_REPO = "Praxis-build/still-water-yoga-693dfbdb";

const mocks = vi.hoisted(() => ({
  flag: true,
  productUrl: null as unknown,
  githubRows: [] as Array<{ slug: string; account_login: string | null; default_repo_full_name?: string | null }>,
  repoResource: null as null | { mode: string; external_ref: Record<string, unknown> },
  resourceError: null as null | { message: string },
  blob: {} as Record<string, unknown>,
  loadAgent: vi.fn(),
  settingReads: [] as Array<{ key: string; tenant: string | null | undefined }>,
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: async (key: string, tenant?: string | null) => {
    mocks.settingReads.push({ key, tenant });
    return key === "build_zavi_repo_counts_as_github" ? mocks.flag : true;
  },
}));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: mocks.loadAgent, listAgents: vi.fn() }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn() }));
vi.mock("@/services/connectors/pipedream/api", () => ({ getAppName: vi.fn() }));
vi.mock("@/services/connectors/composio/catalog", () => ({ listComposioCatalog: async () => [] }));
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
      if (t === "system_config") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { blob: mocks.blob }, error: null }) }),
          }),
        };
      }
      if (t === "tenant_resources") {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.maybeSingle = async () => ({ data: mocks.resourceError ? null : mocks.repoResource, error: mocks.resourceError });
        return q;
      }
      if (t === "connector_metadata") {
        const filters: Record<string, string> = {};
        const rowsFor = (slugs: string[]) =>
          filters.tenant_id === "t1" ? mocks.githubRows.filter((r) => slugs.includes(r.slug)) : [];
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = (c: string, v: string) => {
          filters[c] = v;
          return q;
        };
        q.in = async (_c: string, slugs: string[]) => ({ data: rowsFor(slugs), error: null });
        q.maybeSingle = async () => ({ data: rowsFor([filters.slug])[0] ?? null, error: null });
        q.then = (res: (v: unknown) => unknown) => res({ data: rowsFor([filters.slug]), error: null });
        return q;
      }
      throw new Error(`unexpected table ${t}`);
    },
  }),
}));

import { validateConnectorRequest } from "@/services/mcp/internal/connectors-search";
import { firstMissingChatConnector } from "../setup-schema";
import { connectGateSlugFor } from "../connect-gate";

const okProbe = {
  ok: true,
  missing_vault_keys: [],
  missing_connectors: [],
  missing_required_connectors: [],
  missing_optional_connectors: [],
};

function stillWaterYogaTenant() {
  mocks.productUrl = { marketing: "https://apnatutor.com" };
  mocks.githubRows = [{ slug: "github", account_login: "Praxis-build", default_repo_full_name: ZAVI_REPO }];
  mocks.repoResource = { mode: "provisioned", external_ref: { github_full_name: ZAVI_REPO } };
}

beforeEach(() => {
  mocks.flag = true;
  mocks.productUrl = null;
  mocks.githubRows = [];
  mocks.repoResource = null;
  mocks.resourceError = null;
  mocks.blob = {};
  mocks.settingReads = [];
  mocks.loadAgent.mockReset();
  mocks.loadAgent.mockResolvedValue({
    metadata_praxis: { tools: ["github__read_file"], setup: { chat_requires_connect: true, optional_connectors: ["jira"] } },
  });
});

describe("DEL-1323 B32: a chat on a Zavi-built site never asks to connect GitHub", () => {
  it("the model's connectors__request for github is refused and told to work on the Zavi repo", async () => {
    stillWaterYogaTenant();
    const v = await validateConnectorRequest("t1", "github", { repo_hint: ZAVI_REPO });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toBe("already_connected");
    expect(v.message).toContain(ZAVI_REPO);
    expect(v.message).toMatch(/Do not ask the user to connect GitHub or whether they have an existing codebase/);
    expect(mocks.settingReads).toContainEqual({ key: "build_zavi_repo_counts_as_github", tenant: "t1" });
  });

  it("with no repo on the run, the workspace default repo (the chip) decides", async () => {
    stillWaterYogaTenant();
    const v = await validateConnectorRequest("t1", "github");
    expect(v).toMatchObject({ ok: false, error: "already_connected" });
  });

  it("the engineer connect gate does not stop the chat for github", async () => {
    stillWaterYogaTenant();
    expect(await firstMissingChatConnector("t1", "engineer", okProbe, ZAVI_REPO)).toBeNull();
    expect(await firstMissingChatConnector("t1", "engineer", okProbe)).toBeNull();
  });

  it("the chat-send door agrees with the gate", async () => {
    stillWaterYogaTenant();
    const slug = await connectGateSlugFor({
      tenant_id: "t1",
      agent: { slug: "engineer", metadata_praxis: { setup: { chat_requires_connect: true } } },
      trigger: "chat",
      payload: { repo_hint: ZAVI_REPO },
      text: "Build the whole application end to end, frontend and backend.",
    });
    expect(slug).toBeNull();
  });

  it("the gate still asks for another missing required connector", async () => {
    stillWaterYogaTenant();
    const probe = { ...okProbe, ok: false, missing_required_connectors: ["github", "stripe"] };
    expect(await firstMissingChatConnector("t1", "engineer", probe, ZAVI_REPO)).toBe("stripe");
  });

  it("key off: the old behaviour, github is asked for", async () => {
    stillWaterYogaTenant();
    mocks.flag = false;
    expect(await validateConnectorRequest("t1", "github", { repo_hint: ZAVI_REPO })).toEqual({
      ok: true,
      slug: "github",
      label: "GitHub",
    });
    expect(await firstMissingChatConnector("t1", "engineer", okProbe, ZAVI_REPO)).toBe("github");
  });

  it("a chat pointed at the founder's own repo still asks, even with a Zavi default repo", async () => {
    stillWaterYogaTenant();
    const v = await validateConnectorRequest("t1", "github", { repo_hint: "apnatutor/web" });
    expect(v.ok).toBe(true);
    expect(await firstMissingChatConnector("t1", "engineer", okProbe, "apnatutor/web")).toBe("github");
  });

  it("a repo that is not the tenant's provisioned one never counts (fail closed)", async () => {
    stillWaterYogaTenant();
    mocks.repoResource = { mode: "connected", external_ref: { github_full_name: ZAVI_REPO } };
    expect((await validateConnectorRequest("t1", "github", { repo_hint: ZAVI_REPO })).ok).toBe(true);
    mocks.repoResource = { mode: "provisioned", external_ref: { github_full_name: "Praxis-build/other-site" } };
    expect((await validateConnectorRequest("t1", "github", { repo_hint: ZAVI_REPO })).ok).toBe(true);
    mocks.repoResource = null;
    mocks.resourceError = { message: "boom" };
    expect((await validateConnectorRequest("t1", "github", { repo_hint: ZAVI_REPO })).ok).toBe(true);
  });

  it("other connectors are untouched", async () => {
    stillWaterYogaTenant();
    expect(await validateConnectorRequest("t1", "stripe", { repo_hint: ZAVI_REPO })).toMatchObject({ ok: true });
  });
});
