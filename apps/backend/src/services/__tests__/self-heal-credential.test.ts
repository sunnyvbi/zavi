
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isSelfHealPlatformRun,
  selfHealEnabled,
  selfHealStaffTenantId,
  SELF_HEAL_SOURCE_AGENT,
} from "../self-heal-credential";

const STAFF = "73db45ff-457e-4541-bc8f-bdb625390204";

function reset() {
  delete process.env.SELF_HEAL_ENABLED;
  delete process.env.SELF_HEAL_STAFF_TENANT_ID;
}
beforeEach(reset);
afterEach(reset);

function enable() {
  process.env.SELF_HEAL_ENABLED = "1";
  process.env.SELF_HEAL_STAFF_TENANT_ID = STAFF;
}

describe("self-heal flag + staff tenant", () => {
  it("flag is OFF by default", () => {
    expect(selfHealEnabled()).toBe(false);
    process.env.SELF_HEAL_ENABLED = "1";
    expect(selfHealEnabled()).toBe(true);
    process.env.SELF_HEAL_ENABLED = "true";
    expect(selfHealEnabled()).toBe(false);
  });
  it("staff tenant is empty by default and trimmed", () => {
    expect(selfHealStaffTenantId()).toBe("");
    process.env.SELF_HEAL_STAFF_TENANT_ID = `  ${STAFF}  `;
    expect(selfHealStaffTenantId()).toBe(STAFF);
  });
});

describe("isSelfHealPlatformRun — fail-closed credential gate", () => {
  const ok = { tenant_id: STAFF, source_agent: SELF_HEAL_SOURCE_AGENT, agent_slug: "engineer" };

  it("TRUE only when flag ON + staff + marker + engineer", () => {
    enable();
    expect(isSelfHealPlatformRun(ok)).toBe(true);
  });

  it("FALSE when the flag is off (default)", () => {
    process.env.SELF_HEAL_STAFF_TENANT_ID = STAFF;
    expect(isSelfHealPlatformRun(ok)).toBe(false);
  });

  it("FALSE when no staff tenant configured", () => {
    process.env.SELF_HEAL_ENABLED = "1";
    expect(isSelfHealPlatformRun(ok)).toBe(false);
  });

  it("FALSE for a non-staff (customer) tenant even with the marker", () => {
    enable();
    expect(isSelfHealPlatformRun({ ...ok, tenant_id: "some-customer-tenant" })).toBe(false);
  });

  it("FALSE without the self-heal source_agent marker", () => {
    enable();
    expect(isSelfHealPlatformRun({ ...ok, source_agent: "pm" })).toBe(false);
    expect(isSelfHealPlatformRun({ ...ok, source_agent: undefined })).toBe(false);
  });

  it("FALSE when the agent is not engineer (slug supplied)", () => {
    enable();
    expect(isSelfHealPlatformRun({ ...ok, agent_slug: "operator" })).toBe(false);
  });

  it("TRUE when agent_slug omitted (clone path) — staff+marker+flag suffices", () => {
    enable();
    expect(isSelfHealPlatformRun({ tenant_id: STAFF, source_agent: SELF_HEAL_SOURCE_AGENT })).toBe(true);
    expect(isSelfHealPlatformRun({ tenant_id: STAFF, source_agent: SELF_HEAL_SOURCE_AGENT, agent_slug: null })).toBe(true);
  });
});
