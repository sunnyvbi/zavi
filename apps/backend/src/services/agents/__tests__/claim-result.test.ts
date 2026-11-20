
import { describe, it, expect } from "vitest";
import { asClaimedRow } from "../claim-result";

const CLAIMED = {
  id: "cc907743-7999-45ac-991f-b75ee2d3b9f6",
  tenant_id: "157a6d4d-97ab-41e4-bbf4-fb7e512eec60",
  agent_slug: "pm",
  trigger: "cron",
  payload: { kind: "daily_brief" },
  batch_id: null,
};

describe("asClaimedRow", () => {
  it("returns the row when the CAS really claimed it", () => {
    expect(asClaimedRow(CLAIMED)).toEqual(CLAIMED);
  });

  it("treats a SQL null as not-claimed (kill-switch / row-not-found path)", () => {
    expect(asClaimedRow(null)).toBeNull();
    expect(asClaimedRow(undefined)).toBeNull();
  });

  it("treats a row-of-NULLs as not-claimed", () => {
    const rowOfNulls: Record<string, unknown> = {};
    for (const k of [
      "id",
      "tenant_id",
      "agent_slug",
      "trigger",
      "status",
      "payload",
      "batch_id",
      "started_at",
    ]) {
      rowOfNulls[k] = null;
    }
    expect(rowOfNulls).toBeTruthy();
    expect(asClaimedRow(rowOfNulls)).toBeNull();
  });

  it("treats an empty set as not-claimed", () => {
    expect(asClaimedRow([])).toBeNull();
  });

  it("unwraps a single-element set to the claimed row", () => {
    expect(asClaimedRow([CLAIMED])).toEqual(CLAIMED);
  });

  it("rejects a row missing tenant_id even when id is present", () => {
    expect(asClaimedRow({ ...CLAIMED, tenant_id: null })).toBeNull();
    expect(asClaimedRow({ ...CLAIMED, tenant_id: "" })).toBeNull();
  });

  it("rejects a row missing id even when tenant_id is present", () => {
    expect(asClaimedRow({ ...CLAIMED, id: null })).toBeNull();
    expect(asClaimedRow({ ...CLAIMED, id: "" })).toBeNull();
  });

  it("rejects non-object scalars", () => {
    expect(asClaimedRow("")).toBeNull();
    expect(asClaimedRow(0)).toBeNull();
    expect(asClaimedRow(false)).toBeNull();
    expect(asClaimedRow("cc907743")).toBeNull();
  });
});
