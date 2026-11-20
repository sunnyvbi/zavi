import { describe, it, expect } from "vitest";
import { composioWriteFingerprint } from "../fingerprint";

const base = {
  toolkit: "square", tool_slug: "SQUARE_CREATE_REFUND",
  arguments: { charge: "ch_1", amount: 500, meta: { b: 1, a: [1, { y: 2, x: 1 }] } },
  classification: { destructive: false }, labels: ["moves_money"], decision_class: "composio.moves_money",
  connected_account_id: "ca_1", auth_config_id: "ac_1",
};

describe("composioWriteFingerprint (canonical sha256 of what the approver sees and the worker runs)", () => {
  it("is 64 hex chars and ignores key order at every depth", () => {
    const fp = composioWriteFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const reordered = {
      decision_class: base.decision_class, labels: base.labels, classification: base.classification,
      arguments: { meta: { a: [1, { x: 1, y: 2 }], b: 1 }, amount: 500, charge: "ch_1" },
      tool_slug: base.tool_slug, toolkit: base.toolkit, auth_config_id: "ac_1", connected_account_id: "ca_1",
    };
    expect(composioWriteFingerprint(reordered)).toBe(fp);
  });
  it("ignores fields outside the sealed set (app_name, action, fingerprint itself)", () => {
    expect(composioWriteFingerprint({ ...base, app_name: "X", action: "Y", fingerprint: "z" } as typeof base)).toBe(composioWriteFingerprint(base));
  });
  it("changes when any sealed input changes", () => {
    const fp = composioWriteFingerprint(base);
    for (const v of [
      { ...base, arguments: { ...base.arguments, amount: 50000 } },
      { ...base, arguments: { ...base.arguments, meta: { b: 1, a: [1, { y: 3, x: 1 }] } } },
      { ...base, tool_slug: "SQUARE_CREATE_PAYMENT" },
      { ...base, toolkit: "stripe" },
      { ...base, labels: ["moves_money", "deletes_data"] },
      { ...base, labels: [] },
      { ...base, classification: { destructive: true } },
      { ...base, decision_class: "composio.write" },
      { ...base, connected_account_id: "ca_2" },
      { ...base, auth_config_id: "ac_2" },
    ]) expect(composioWriteFingerprint(v)).not.toBe(fp);
  });
  it("array order inside arguments matters (it is data), label order does not (it is a set)", () => {
    expect(composioWriteFingerprint({ ...base, arguments: { list: [1, 2] } })).not.toBe(composioWriteFingerprint({ ...base, arguments: { list: [2, 1] } }));
    const two = { ...base, labels: ["moves_money", "deletes_data"] };
    expect(composioWriteFingerprint(two)).toBe(composioWriteFingerprint({ ...two, labels: ["deletes_data", "moves_money"] }));
  });
});
