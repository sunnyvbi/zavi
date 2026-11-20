
import { describe, it, expect } from "vitest";
import {
  loadApprovedTenantRoutinesForAgent,
  synthesizeApprovedRoutineTools,
  type RoutineInjectDb,
  type RoutineInjectQuery,
} from "../inject";
import { synthesizeRoutineToolName, ROUTINE_TOOL_NAME_RE } from "../tool-name";

interface UpdateRec {
  values: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeDb(rows: Record<string, unknown>[]): { db: RoutineInjectDb; updates: UpdateRec[] } {
  const updates: UpdateRec[] = [];
  function query(): RoutineInjectQuery {
    let mode: "select" | "update" = "select";
    let updateValues: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const apply = () => rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    const builder: RoutineInjectQuery = {
      select() {
        return builder;
      },
      update(values) {
        mode = "update";
        updateValues = values;
        return builder;
      },
      eq(col, val) {
        filters[col] = val;
        return builder;
      },
      then<T>(onfulfilled: (v: { data: unknown; error: unknown }) => T) {
        if (mode === "update") {
          updates.push({ values: { ...updateValues }, filters: { ...filters } });
          for (const r of apply()) Object.assign(r, updateValues);
          return Promise.resolve(onfulfilled({ data: null, error: null }));
        }
        return Promise.resolve(onfulfilled({ data: apply(), error: null }));
      },
    };
    return builder;
  }
  return { db: { from: () => query() }, updates };
}

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";

function approvedRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const id = (over.id as string) ?? "routine-A1";
  const agent_slug = (over.agent_slug as string) ?? "cto-engineer";
  const synth = synthesizeRoutineToolName(agent_slug, id);
  return {
    id,
    tenant_id: TENANT_A,
    agent_slug,
    status: "approved",
    emitted_tool_name: synth.ok ? synth.tool_name : null,
    routine_name: "deploy and verify",
    source_note_ids: ["note-1", "note-2"],
    provenance: {},
    faithfulness_clean: true,
    ...over,
  };
}

describe("loadApprovedTenantRoutinesForAgent — scoping", () => {
  it("returns only APPROVED rows for the exact (tenant, agent)", async () => {
    const { db } = makeDb([
      approvedRow({ id: "s1" }),
      approvedRow({ id: "s2", status: "staged" }),
      approvedRow({ id: "s3", agent_slug: "operator" }),
      approvedRow({ id: "s4", tenant_id: TENANT_B }),
    ]);
    const rows = await loadApprovedTenantRoutinesForAgent(TENANT_A, "cto-engineer", db);
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  it("returns [] for empty tenant or agent", async () => {
    const { db } = makeDb([approvedRow()]);
    expect(await loadApprovedTenantRoutinesForAgent("", "cto-engineer", db)).toEqual([]);
    expect(await loadApprovedTenantRoutinesForAgent(TENANT_A, "", db)).toEqual([]);
  });
});

describe("synthesizeApprovedRoutineTools — single source", () => {
  it("synthesizes a ResolvedTool for an approved routine with the server-generated id", async () => {
    const row = approvedRow({ id: "s1" });
    const { db } = makeDb([row]);
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db);
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t.name).toBe(row.emitted_tool_name);
    expect(t.name).not.toBe(row.routine_name);
    expect(ROUTINE_TOOL_NAME_RE.test(t.name)).toBe(true);
    expect(t.server_id).toBe("tenant_skill");
    expect(t.description).toMatch(/Learned from 2 sources on \d{4}-\d{2}-\d{2}; review before use/);
    expect(t.description).toMatch(/faithfulness_clean=true/);
  });

  it("marks +external when provenance.external is set", async () => {
    const { db } = makeDb([approvedRow({ id: "s1", provenance: { external: true } })]);
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db);
    expect(tools[0].description).toMatch(/2 sources \+external/);
  });

  it("kill-switch OFF drops tenant_authored routines but keeps machine_distilled", async () => {
    const { db } = makeDb([
      approvedRow({ id: "m1", provenance_origin: "machine_distilled" }),
      approvedRow({ id: "t1", provenance_origin: "tenant_authored" }),
    ]);
    const off = async () => false;
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db, off);
    const machineName = synthesizeRoutineToolName("cto-engineer", "m1");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(machineName.ok ? machineName.tool_name : "");
  });

  it("kill-switch ON surfaces both origins", async () => {
    const { db } = makeDb([
      approvedRow({ id: "m1", provenance_origin: "machine_distilled" }),
      approvedRow({ id: "t1", provenance_origin: "tenant_authored" }),
    ]);
    const on = async () => true;
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db, on);
    expect(tools).toHaveLength(2);
  });

  it("does NOT surface a staged routine", async () => {
    const { db } = makeDb([approvedRow({ id: "s2", status: "staged" })]);
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db);
    expect(tools).toHaveLength(0);
  });

  it("does NOT surface another tenant's approved routine (cross-tenant isolation)", async () => {
    const { db } = makeDb([approvedRow({ id: "sB", tenant_id: TENANT_B })]);
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db);
    expect(tools).toHaveLength(0);
  });

  it("QUARANTINES + skips a row whose emitted_tool_name is null/invalid", async () => {
    const bad = approvedRow({ id: "s1", emitted_tool_name: null });
    const { db, updates } = makeDb([bad]);
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db);
    expect(tools).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].values.status).toBe("quarantined");
    expect(updates[0].filters.id).toBe("s1");
    expect(updates[0].filters.tenant_id).toBe(TENANT_A);
  });

  it("QUARANTINES a row whose emitted_tool_name collides with a reserved prefix", async () => {
    const bad = approvedRow({ id: "s1", emitted_tool_name: "praxis__action" });
    const { db, updates } = makeDb([bad]);
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db);
    expect(tools).toHaveLength(0);
    expect(updates[0].values.status).toBe("quarantined");
  });

  it("QUARANTINES a row whose emitted_tool_name embeds a DIFFERENT agent slug", async () => {
    const otherSynth = synthesizeRoutineToolName("operator", "s1");
    const bad = approvedRow({ id: "s1", emitted_tool_name: otherSynth.ok ? otherSynth.tool_name : "x" });
    const { db, updates } = makeDb([bad]);
    const tools = await synthesizeApprovedRoutineTools(TENANT_A, "cto-engineer", db);
    expect(tools).toHaveLength(0);
    expect(updates[0].values.status).toBe("quarantined");
  });
});
