
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

const TENANT_UPCAR = "73db45ff-457e-4541-bc8f-bdb625390204";
const TENANT_OTHER = "00000000-0000-0000-0000-000000000099";

type Resolve = { data: unknown; error: { message: string } | null };

const sysCfgResolve: Resolve = { data: null, error: null };
const connectorsResolve: Resolve = { data: null, error: null };

function newSysCfgTable(): Record<string, unknown> {
  const t = {} as Record<string, unknown>;
  (t as { select: () => typeof t }).select = vi.fn(() => t);
  (t as { eq: () => typeof t }).eq = vi.fn(() => t);
  (t as { maybeSingle: () => Promise<Resolve> }).maybeSingle = vi.fn(() =>
    Promise.resolve(sysCfgResolve),
  );
  return t;
}

function newConnectorsTable(): Record<string, unknown> {
  const t = {} as Record<string, unknown>;
  (t as { select: () => typeof t }).select = vi.fn(() => t);
  (t as { eq: () => Promise<Resolve> }).eq = vi.fn(() =>
    Promise.resolve(connectorsResolve),
  );
  return t;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (name: string) => {
      if (name === "system_config") return newSysCfgTable();
      if (name === "connector_metadata") return newConnectorsTable();
      throw new Error(`unexpected table in test: ${name}`);
    },
  }),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (typeof p === "string" && p.includes("/_core/connectors/")) {
        return MOCK_FS_FILES.has(p);
      }
      return actual.existsSync(p);
    }),
    readFileSync: vi.fn(
      (p: string | Buffer | URL, ...args: unknown[]) => {
        if (typeof p === "string" && p.includes("/_core/connectors/")) {
          const v = MOCK_FS_FILES.get(p);
          if (v === undefined) throw new Error(`ENOENT (mock): ${p}`);
          return v;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual.readFileSync as any)(p, ...args);
      },
    ),
  };
});

const MOCK_FS_FILES = new Map<string, string>();

import { loadTenantConnectorBlocks } from "../generic-dispatcher";

const CONNECTORS_ROOT = path.join(
  process.cwd(),
  "src",
  "agents",
  "_core",
  "connectors",
);

function stubPath(slug: string): string {
  return path.join(CONNECTORS_ROOT, slug, "skill.md");
}

function setStub(slug: string, body: string, provider = slug): void {
  const fm = `---\nprovider: ${provider}\napplies_to: ["*"]\n---\n${body}`;
  MOCK_FS_FILES.set(stubPath(slug), fm);
}

beforeEach(() => {
  MOCK_FS_FILES.clear();
  sysCfgResolve.data = { blob: { skill_paging_enabled_tenants: [TENANT_UPCAR] } };
  sysCfgResolve.error = null;
  connectorsResolve.data = [];
  connectorsResolve.error = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadTenantConnectorBlocks — Wave A", () => {
  it("returns '' when an explicit allowlist exists and the tenant is not in it", async () => {
    connectorsResolve.data = [{ slug: "slack" }];
    setStub("slack", "Slack connector skill body");
    const out = await loadTenantConnectorBlocks(TENANT_OTHER);
    expect(out).toBe("");
  });

  it("DEFAULT-ON: splices for any tenant when NO allowlist key is configured", async () => {
    sysCfgResolve.data = { blob: {} };
    connectorsResolve.data = [{ slug: "slack" }];
    setStub("slack", "BODY_SLACK");
    const out = await loadTenantConnectorBlocks(TENANT_OTHER);
    expect(out).toContain("BODY_SLACK");
  });

  it("kill switch: skill_paging_disabled_tenants wins over the default", async () => {
    sysCfgResolve.data = { blob: { skill_paging_disabled_tenants: [TENANT_OTHER] } };
    connectorsResolve.data = [{ slug: "slack" }];
    setStub("slack", "BODY_SLACK");
    expect(await loadTenantConnectorBlocks(TENANT_OTHER)).toBe("");
    expect(await loadTenantConnectorBlocks(TENANT_UPCAR)).toContain("BODY_SLACK");
  });

  it("returns '' when flag is enabled but the tenant has 0 connectors", async () => {
    connectorsResolve.data = [];
    const out = await loadTenantConnectorBlocks(TENANT_UPCAR);
    expect(out).toBe("");
  });

  it("returns the single-file body when the tenant has 1 connector", async () => {
    connectorsResolve.data = [{ slug: "slack" }];
    setStub("slack", "Slack body content for splice.");
    const out = await loadTenantConnectorBlocks(TENANT_UPCAR);
    expect(out).toContain("Slack body content for splice.");
    expect(out.endsWith("---\n\n")).toBe(true);
  });

  it("concatenates N connector bodies in deterministic alphabetical order", async () => {
    connectorsResolve.data = [
      { slug: "slack" },
      { slug: "github" },
      { slug: "linear" },
    ];
    setStub("slack", "BODY_SLACK");
    setStub("github", "BODY_GITHUB");
    setStub("linear", "BODY_LINEAR");
    const out = await loadTenantConnectorBlocks(TENANT_UPCAR);
    const idxGh = out.indexOf("BODY_GITHUB");
    const idxLi = out.indexOf("BODY_LINEAR");
    const idxSl = out.indexOf("BODY_SLACK");
    expect(idxGh).toBeGreaterThanOrEqual(0);
    expect(idxLi).toBeGreaterThan(idxGh);
    expect(idxSl).toBeGreaterThan(idxLi);
  });

  it("skips and warns when a connector's skill.md is missing on disk", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    connectorsResolve.data = [{ slug: "slack" }, { slug: "nonexistent" }];
    setStub("slack", "BODY_SLACK");
    const out = await loadTenantConnectorBlocks(TENANT_UPCAR);
    expect(out).toContain("BODY_SLACK");
    expect(out).not.toContain("nonexistent");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("connector skill missing"),
    );
  });

  it("falls back to the default (ON) when system_config read errors", async () => {
    sysCfgResolve.error = { message: "simulated DB blip" };
    sysCfgResolve.data = null;
    connectorsResolve.data = [{ slug: "slack" }];
    setStub("slack", "BODY_SLACK");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await loadTenantConnectorBlocks(TENANT_UPCAR);
    expect(out).toContain("BODY_SLACK");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skill-paging flag read failed"),
    );
  });

  it("returns '' (fail-closed) when connector_metadata read errors", async () => {
    connectorsResolve.error = { message: "simulated DB blip" };
    connectorsResolve.data = null;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await loadTenantConnectorBlocks(TENANT_UPCAR);
    expect(out).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("connector_metadata read failed"),
    );
  });

  it("returns '' for empty/non-string tenant_id (defensive)", async () => {
    expect(await loadTenantConnectorBlocks("")).toBe("");
    // @ts-expect-error — runtime defensive check
    expect(await loadTenantConnectorBlocks(null)).toBe("");
    // @ts-expect-error — runtime defensive check
    expect(await loadTenantConnectorBlocks(undefined)).toBe("");
  });

  it("strips YAML frontmatter — only body content reaches the prompt", async () => {
    connectorsResolve.data = [{ slug: "slack" }];
    setStub("slack", "VISIBLE_BODY_ONLY");
    const out = await loadTenantConnectorBlocks(TENANT_UPCAR);
    expect(out).toContain("VISIBLE_BODY_ONLY");
    expect(out).not.toContain("applies_to");
    expect(out).not.toContain("provider: slack");
  });

  it("dedupes provider slugs when connector_metadata returns duplicates", async () => {
    connectorsResolve.data = [{ slug: "slack" }, { slug: "slack" }];
    setStub("slack", "BODY_SLACK_ONCE");
    const out = await loadTenantConnectorBlocks(TENANT_UPCAR);
    const occurrences = out.split("BODY_SLACK_ONCE").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("loadTenantConnectorBlocks — per-agent exclude (engineer cost v2)", () => {
  it("skips excluded providers and keeps the rest; default [] keeps all", async () => {
    connectorsResolve.data = [{ slug: "operator_db" }, { slug: "slack" }];
    setStub("operator_db", "BODY_OPDB");
    setStub("slack", "BODY_SLACK");
    expect(await loadTenantConnectorBlocks(TENANT_UPCAR)).toContain("BODY_OPDB");
    const engineer = await loadTenantConnectorBlocks(TENANT_UPCAR, false, ["operator_db"]);
    expect(engineer).not.toContain("BODY_OPDB");
    expect(engineer).toContain("BODY_SLACK");
  });

  it("returns '' when the only connector is excluded", async () => {
    connectorsResolve.data = [{ slug: "operator_db" }];
    setStub("operator_db", "BODY_OPDB");
    expect(await loadTenantConnectorBlocks(TENANT_UPCAR, false, ["operator_db"])).toBe("");
  });
});
