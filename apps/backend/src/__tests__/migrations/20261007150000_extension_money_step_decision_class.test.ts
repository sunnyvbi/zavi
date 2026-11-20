import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WEB_ONLY_APPROVE_FIELDS, isWebOnlyApproveClass } from "../../services/approvals/money-card";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20261007150000_extension_money_step_decision_class.sql"),
  "utf8",
);
const dispatchSrc = readFileSync(join(__dirname, "..", "..", "..", "workers", "functions", "dispatch-decision.ts"), "utf8");
const neverAutoBlock = dispatchSrc.slice(
  dispatchSrc.indexOf("export const NEVER_AUTO_DECISION_CLASSES"),
  dispatchSrc.indexOf("]);", dispatchSrc.indexOf("export const NEVER_AUTO_DECISION_CLASSES")),
);
const row = sql.split("\n").find((l) => /^\s*\('extension\.money_step',/.test(l)) ?? "";

describe("20261007150000_extension_money_step_decision_class", () => {
  it("registers the class: approval, NULL handler, never_auto, not allowlistable, high", () => {
    expect(sql).toMatch(/insert\s+into\s+decision_classes\s*\(slug, description, default_autonomy, dispatch_handler, never_auto, click_allowlistable, severity\)/i);
    expect(row).toMatch(/'approval',\s*null,\s*true,\s*false,\s*'high'\)\s*$/);
  });

  it("is idempotent", () => {
    expect(sql).toMatch(/on conflict \(slug\) do update/i);
  });

  it("is mirrored in the worker's never-auto set (layer 3)", () => {
    expect(neverAutoBlock).toMatch(/^\s*"extension\.money_step",/m);
  });

  it("is a sealed, card-only approve class", () => {
    expect(isWebOnlyApproveClass("extension.money_step")).toBe(true);
    expect(WEB_ONLY_APPROVE_FIELDS["extension.money_step"]).toEqual(
      expect.arrayContaining(["host", "label", "op", "op_args", "value", "frame_url", "frame_session", "backend_node_id", "screenshot_id", "run_owner_user_id", "held_op_id"]),
    );
  });
});
