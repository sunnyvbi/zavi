import { describe, expect, it } from "vitest";
import { oneClickApprovable } from "./oneClick";

const row = (decision_class: string, over: Record<string, unknown> = {}) => ({
  decision_class,
  handler: null as string | null,
  body: {} as Record<string, unknown>,
  ...over,
});

describe("oneClickApprovable", () => {
  it("a plain non-money row is one click for an owner, admin or member", () => {
    for (const r of ["owner", "admin", "member"] as const) {
      expect(oneClickApprovable(row("pm.needs_action", { handler: "pm.needs_action" }), r), r).toBe(true);
      expect(oneClickApprovable(row("channel.recipe_step"), r), r).toBe(true);
    }
    expect(oneClickApprovable(row("pm.needs_action"), null)).toBe(true);
  });

  it("never for rows whose approve must carry extras or show its own card", () => {
    for (const cls of ["growth.save_business_controls", "social.publish.v2", "email_campaign.create_and_send", "bulk_outbound.send", "stripe.create_payment", "stripe.remit_to_tenant", "extension.money_step", "composio.write", "composio.moves_money"]) {
      expect(oneClickApprovable(row(cls), "owner"), cls).toBe(false);
    }
    expect(oneClickApprovable(row("x.y", { handler: "composio.execute_tool" }), "owner")).toBe(false);
    expect(oneClickApprovable(row("x.y", { body: { full_card: true } }), "owner")).toBe(false);
  });

  it("never for high-stakes rows (ads, RED blast radius, refunds, a channel action that runs an ad change)", () => {
    expect(oneClickApprovable(row("google_ads.update_campaign_budget"), "owner")).toBe(false);
    expect(oneClickApprovable(row("meta_ads.budget"), "owner")).toBe(false);
    expect(oneClickApprovable(row("pm.x", { body: { decision_evidence: { blast_radius: "RED" } } }), "owner")).toBe(false);
    expect(oneClickApprovable(row("ops.refund", { handler: "stripe.refund" }), "owner")).toBe(false);
    expect(oneClickApprovable(row("channel.recipe_step", { exec_class: "google_ads.update_campaign_budget" }), "owner")).toBe(false);
  });

  it("never for a viewer, nor for a member on an owner/admin-only row, nor for an unwired handler", () => {
    expect(oneClickApprovable(row("pm.x"), "viewer")).toBe(false);
    expect(oneClickApprovable(row("pm.x", { needs_owner_admin: true }), "member")).toBe(false);
    expect(oneClickApprovable(row("pm.x", { needs_owner_admin: true }), "admin")).toBe(true);
    expect(oneClickApprovable(row("outbound.x", { handler: "stripe.refund" }), "owner")).toBe(false);
  });
});
