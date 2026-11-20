import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  writes: [] as { op: string; values: Record<string, unknown> }[],
  followsApp: true as boolean | "throw",
}));

vi.mock("@/services/supabase", () => {
  function from(table: string) {
    if (table !== "connector_metadata") throw new Error(`unexpected table ${table}`);
    const filters: [string, unknown][] = [];
    let pending: { op: "update"; values: Row } | null = null;
    const match = () => store.rows.filter((r) => filters.every(([k, v]) => r[k] === v));
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return q;
      },
      maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
      update: (values: Row) => {
        pending = { op: "update", values };
        return q;
      },
      upsert: async (values: Row) => {
        store.writes.push({ op: "upsert", values });
        store.rows.push({ ...values });
        return { error: null };
      },
      then: (resolve: (v: { error: null }) => void) => {
        if (pending) {
          store.writes.push({ op: pending.op, values: pending.values });
          for (const r of match()) Object.assign(r, pending.values);
        }
        resolve({ error: null });
      },
    };
    return q;
  }
  return { serviceClient: () => ({ from }) };
});

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string) => {
      if (key !== "build_repo_follows_app") return actual.getBoolSetting(key as never, "t");
      if (store.followsApp === "throw") throw new Error("settings down");
      return store.followsApp;
    }),
  };
});

vi.mock("@/services/sites/public-resolver", () => ({
  sitePublicResolver: () => ({ byRepo: async () => null }),
}));

vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: async (tenant_id: string) =>
    ((store.rows.find((r) => r.tenant_id === tenant_id)?.repo_full_names as string[]) ?? []),
}));

import { ensureProvisionedGithubConnector } from "@/services/agents/start-product-build";
import { resolveRepoFullName } from "@/services/agents/repo-resolver";
import { APP_SETTINGS } from "@/services/settings/registry";

const T = "693dfbdb-0000-0000-0000-000000000000";
const YOGA = "Praxis-build/still-water-yoga-693dfbdb";
const DOG = "Praxis-build/apna-tutor-693dfbdb";

function yogaRow(): Row {
  return {
    tenant_id: T,
    slug: "github",
    account_login: "Praxis-build",
    repo_full_names: [YOGA],
    default_repo_full_name: YOGA,
    repo_default_branches: { [YOGA]: "main" },
  };
}

const resolveDeps = { assertProvisionedRepoTarget: async () => ({ ok: false, reason: "not_provisioned" }) } as never;

beforeEach(() => {
  store.rows = [];
  store.writes = [];
  store.followsApp = true;
});

describe("DEL-1323 B6: the chat repo follows the current app", () => {
  it("a second build moves the Zavi-made connection to the new repo, so a Home edit with no repo named goes to the new app", async () => {
    store.rows.push(yogaRow());
    expect(await resolveRepoFullName({ tenant_id: T }, resolveDeps)).toBe(YOGA);

    await ensureProvisionedGithubConnector(T, DOG, "main");

    const row = store.rows[0];
    expect(row.default_repo_full_name).toBe(DOG);
    expect(row.repo_full_names).toEqual([DOG]);
    expect(row.repo_default_branches).toEqual({ [DOG]: "main" });
    expect(row.account_login).toBe("Praxis-build");
    expect(await resolveRepoFullName({ tenant_id: T }, resolveDeps)).toBe(DOG);
    await expect(resolveRepoFullName({ tenant_id: T, repo_hint: YOGA }, resolveDeps)).rejects.toThrow(
      /repo_hint_not_connected|neither/,
    );
  });

  it("never touches a GitHub account the user connected themselves", async () => {
    store.rows.push({
      tenant_id: T,
      slug: "github",
      account_login: "mohit-dev",
      installation_id: 42,
      repo_full_names: ["mohit-dev/shop"],
      default_repo_full_name: "mohit-dev/shop",
    });
    await ensureProvisionedGithubConnector(T, DOG, "main");
    expect(store.writes).toEqual([]);
    expect(store.rows[0].default_repo_full_name).toBe("mohit-dev/shop");
  });

  it("writes nothing when the connection already points at this build's repo", async () => {
    store.rows.push({ ...yogaRow(), repo_full_names: [DOG], default_repo_full_name: DOG });
    await ensureProvisionedGithubConnector(T, DOG, "main");
    expect(store.writes).toEqual([]);
  });

  it("with the key off, the first build's repo stays attached exactly as before", async () => {
    store.followsApp = false;
    store.rows.push(yogaRow());
    await ensureProvisionedGithubConnector(T, DOG, "main");
    expect(store.writes).toEqual([]);
    expect(store.rows[0]).toEqual(yogaRow());
  });

  it("a failed settings read keeps the old behaviour", async () => {
    store.followsApp = "throw";
    store.rows.push(yogaRow());
    await ensureProvisionedGithubConnector(T, DOG, "main");
    expect(store.writes).toEqual([]);
  });

  it("a workspace with no GitHub row still gets the Zavi-made connection", async () => {
    await ensureProvisionedGithubConnector(T, DOG, "main");
    expect(store.writes.map((w) => w.op)).toEqual(["upsert"]);
    expect(store.rows[0]).toMatchObject({ default_repo_full_name: DOG, repo_full_names: [DOG], account_login: "Praxis-build" });
  });

  it("registers build_repo_follows_app as a per-tenant key, default on", () => {
    const entry = (APP_SETTINGS as Record<string, { defaultValue: unknown; scope: string; type: string }>).build_repo_follows_app;
    expect(entry).toMatchObject({ defaultValue: true, scope: "per-tenant", type: "boolean" });
  });
});
