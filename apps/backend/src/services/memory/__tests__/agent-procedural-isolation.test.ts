import { describe, it, expect } from "vitest";
import { contentHash } from "../content-hash";
import { maybeResolveConflict } from "../conflict-resolution";
import { PRIVATE_NOTE_TYPE_SET, PRIVATE_NOTE_TYPES } from "../index";

describe("agent_procedural — per-agent content-hash dedup scoping", () => {
  const tenant = "11111111-1111-1111-1111-111111111111";
  const body = "Always open a draft PR, never merge directly";

  it("gives two DIFFERENT agents DIFFERENT hashes for the same procedural body", () => {
    const a = contentHash(tenant, "agent_procedural", body, "engineer");
    const b = contentHash(tenant, "agent_procedural", body, "support-lead");
    expect(a).not.toBe(b);
  });

  it("gives the SAME agent the SAME hash (idempotent write for one agent)", () => {
    const a1 = contentHash(tenant, "agent_procedural", body, "engineer");
    const a2 = contentHash(tenant, "agent_procedural", body, "engineer");
    expect(a1).toBe(a2);
  });

  it("stays byte-identical for NON-per-agent types regardless of agent_slug (no SQL drift)", () => {
    const withSlug = contentHash(tenant, "tenant_reference", body, "engineer");
    const withNull = contentHash(tenant, "tenant_reference", body, null);
    const legacy3arg = contentHash(tenant, "tenant_reference", body);
    expect(withSlug).toBe(withNull);
    expect(withSlug).toBe(legacy3arg);
  });
});

describe("agent_procedural — conflict-resolution never crosses agents", () => {
  const tenant = "22222222-2222-2222-2222-222222222222";
  const explodingFlag = async () => {
    throw new Error("flagCheck must NOT be reached for private note types");
  };

  it("returns null (skips) for every PRIVATE note type", async () => {
    for (const nt of PRIVATE_NOTE_TYPES) {
      const out = await maybeResolveConflict(
        tenant,
        { title: "t", body: "b", note_type: nt },
        undefined,
        explodingFlag,
      );
      expect(out).toBeNull();
    }
  });

  it("PRIVATE_NOTE_TYPE_SET contains exactly the two private types", () => {
    expect(PRIVATE_NOTE_TYPE_SET.has("agent_experience")).toBe(true);
    expect(PRIVATE_NOTE_TYPE_SET.has("agent_procedural")).toBe(true);
    expect(PRIVATE_NOTE_TYPE_SET.has("tenant_reference")).toBe(false);
    expect(PRIVATE_NOTE_TYPE_SET.has("skill")).toBe(false);
  });
});
