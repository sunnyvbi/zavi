import { describe, it, expect } from "vitest";
import { parseCustomAgentCard, deliverLabel, triggerLabel } from "./customAgentCard";

const draft = {
  name: "Standup bot",
  role: "",
  instructions: "Summarize yesterday.",
  tools: [],
  triggers: [{ kind: "schedule", cron: "0 9 * * 1-5", tz: "America/Los_Angeles" }],
  deliver: { kind: "chat_thread", thread_id: "55555555-5555-4555-8555-555555555555" },
};

describe("parseCustomAgentCard", () => {
  it("reads a draft", () => {
    const c = parseCustomAgentCard({ kind: "draft", draft });
    expect(c?.kind).toBe("draft");
  });
  it("reads an older persisted draft that still carries est_daily_credits, and drops it", () => {
    const c = parseCustomAgentCard({ kind: "draft", draft: { ...draft, est_daily_credits: 243 } });
    expect(c?.kind).toBe("draft");
    expect(c?.kind === "draft" && c.draft).not.toHaveProperty("est_daily_credits");
    expect(c?.kind === "draft" && c.draft.name).toBe("Standup bot");
  });
  it("reads the Free refusal", () => {
    const c = parseCustomAgentCard({
      kind: "refusal",
      refusal: { code: "plan_upgrade_required", message: "Custom agents are available on paid plans.", required_tier: "starter" },
    });
    expect(c).toMatchObject({ kind: "refusal", refusal: { message: "Custom agents are available on paid plans." } });
  });
  it.each([null, undefined, "x", {}, { kind: "draft" }, { kind: "draft", draft: { ...draft, triggers: [{ kind: "nope" }] } }])(
    "no card on doubt: %j",
    (raw) => {
      expect(parseCustomAgentCard(raw)).toBeNull();
    },
  );
});

describe("labels", () => {
  it("names the destination and the trigger", () => {
    expect(deliverLabel({ kind: "email" })).toBe("Email, to your workspace's recipients");
    expect(deliverLabel(null)).toBe("Not delivered anywhere yet");
    expect(deliverLabel({ kind: "telegram", chat_id: 1 })).toBe("Telegram");
    expect(deliverLabel({ kind: "discord", channel_id: "D1", guild_id: "G1" })).toBe("Discord");
    expect(triggerLabel({ kind: "watch", interval_minutes: 15, condition: "pricing changes" })).toBe(
      "Checks every 15 min: pricing changes",
    );
  });
});

import { scheduleLabel, zoneLabel } from "./customAgentCard";

describe("scheduleLabel", () => {
  it.each([
    ["0 9 * * 1-5", "America/Los_Angeles", "Weekdays at 9:00 AM (PT)"],
    ["0 8 * * 1", "Asia/Kolkata", "Every Monday at 8:00 AM (IST)"],
    ["30 19 * * *", "UTC", "Every day at 7:30 PM (UTC)"],
    ["0 0 * * 0,6", "America/New_York", "Weekends at 12:00 AM (ET)"],
    ["15 12 * * 1,3,5", "Europe/Berlin", "Every Monday, Wednesday and Friday at 12:15 PM (Berlin)"],
    ["0 7 * * 0", undefined, "Every Sunday at 7:00 AM"],
  ])("%s in %s → %s", (cron, tz, want) => {
    expect(scheduleLabel(cron, tz)).toBe(want);
  });

  it.each(["*/15 9 * * *", "0 */2 * * 1-5", "0 9 1 * *", "0 9 * 1 *", "0 9-17 * * *", "0 9 * * MON", "nonsense", "99 9 * * *"])(
    "falls back for %s",
    (cron) => {
      expect(scheduleLabel(cron, "UTC")).toBe(`Custom schedule (${cron})`);
    },
  );

  it.each([
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 */2 * * *", "Every 2 hours"],
    ["0 * * * *", "Every hour"],
  ])("interval %s reads %s", (cron, label) => {
    expect(scheduleLabel(cron, "UTC")).toBe(label);
  });

  it("short zone labels", () => {
    expect(zoneLabel("America/Chicago")).toBe("CT");
    expect(zoneLabel("America/Sao_Paulo")).toBe("Sao Paulo");
  });
});

import { draftFromServerAgent } from "./customAgentCard";

describe("draftFromServerAgent (reload restores what was created)", () => {
  it("takes every editable field from the server", () => {
    const got = draftFromServerAgent(
      {
        id: "a1",
        status: "active",
        name: "Renamed bot",
        role: "New role",
        instructions: "New instructions",
        triggers: [{ id: "t1", kind: "watch", cron: null, tz: null, interval_minutes: 30, condition: "price changes", enabled: true }],
        deliver: { kind: "email" },
      },
      draft as never,
    );
    expect(got).toMatchObject({
      name: "Renamed bot",
      role: "New role",
      instructions: "New instructions",
      triggers: [{ kind: "watch", interval_minutes: 30, condition: "price changes" }],
      deliver: { kind: "email" },
    });
  });
  it("a cleared destination stays cleared", () => {
    expect(draftFromServerAgent({ id: "a1", status: "active", name: "X", deliver: null }, draft as never).deliver).toBeNull();
  });
});
