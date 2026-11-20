
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CHANNEL_BUDGET_EXHAUSTED, CHANNEL_OUT_OF_CREDITS, channelRunRefusalMessage } from "./channelBudget";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  HERE,
  "../../../../../supabase/migrations/20260901210000_channel_credit_cap.sql",
);

describe("channel credit-cap copy", () => {
  it("names the same window channel_credits_30d() enforces", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const m = sql.match(/interval\s+'(\d+)\s+days'/);
    expect(m, "the cap migration must declare a day interval").toBeTruthy();
    const days = m![1];
    expect(days).toBe("30");
    expect(CHANNEL_BUDGET_EXHAUSTED).toContain(`${days} days`);
  });

  it("does not promise a calendar-month reset the cap never performs", () => {
    expect(CHANNEL_BUDGET_EXHAUSTED).not.toMatch(
      /this month|next month|next cycle|resets on/i,
    );
  });

  it("tells the operator the budget frees up gradually", () => {
    expect(CHANNEL_BUDGET_EXHAUSTED).toMatch(/frees up|as older runs/i);
  });
});

describe("channelRunRefusalMessage", () => {
  it("tells an out-of-credits founder to top up, not that we broke", () => {
    expect(channelRunRefusalMessage(402, "insufficient_credits")).toBe(CHANNEL_OUT_OF_CREDITS);
  });
  it("keeps the 30-day cap copy for the cap", () => {
    expect(channelRunRefusalMessage(402, "cap_reached")).toBe(CHANNEL_BUDGET_EXHAUSTED);
  });
  it("keeps the ours-not-yours copy for a 5xx and the retry copy otherwise", () => {
    expect(channelRunRefusalMessage(500, "enqueue_failed")).toMatch(/couldn't start/);
    expect(channelRunRefusalMessage(null, null)).toMatch(/Try again/);
  });
});

describe("plan upgrade refusal", () => {
  it("a 403 plan_upgrade_required asks for an upgrade, not credits", async () => {
    const { channelRunRefusalMessage, CHANNEL_PLAN_UPGRADE } = await import("./channelBudget");
    expect(channelRunRefusalMessage(403, "plan_upgrade_required")).toBe(CHANNEL_PLAN_UPGRADE);
    expect(CHANNEL_PLAN_UPGRADE).not.toMatch(/—/);
  });
});
