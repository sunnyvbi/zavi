const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { describe, it, expect } = require("./helpers/vitest-shim.cjs");

const L = loadTs(path.join(__dirname, "../src/features/agentBuilder/logic.ts"));
const { CUSTOM_AGENT_HONEST_LINE, TEST_RUN_CONFIRM, TERMINAL_RUN_STATUSES, PAUSED_AFTER_FAILS, parseCustomAgentCard, deliverLabel, zoneLabel, scheduleLabel, triggerLabel, draftFromServerAgent, pausedLine, plainRunText, whenItRuns, sendsResultsTo, sendsResultsLine, runResultMarkdown, runStatus, pastWhen, savedWhen, nextRun, receiptLine, receiptsByRun, findBuilderAgent } = L;

"use strict";
const trig = (over) => ({
    id: "t1",
    kind: "schedule",
    cron: "0 9 * * 1-5",
    tz: "America/Los_Angeles",
    interval_minutes: null,
    condition: null,
    enabled: true,
    next_due_at: null,
    ...over,
});
describe("whenItRuns", () => {
    it("says the schedule in plain words, reusing the chat card's wording", () => {
        expect(whenItRuns([trig({})])).toBe("Weekdays at 9:00 AM (PT)");
        expect(whenItRuns([trig({ kind: "watch", cron: null, interval_minutes: 60, condition: "the pricing page changes" })])).toBe("Checks every 60 min: the pricing page changes");
        expect(whenItRuns([])).toBe("Only when you run it");
    });
});
describe("runStatus", () => {
    it("maps run statuses to the page's words", () => {
        expect(runStatus({ status: "success", test: false }).label).toBe("Finished");
        expect(runStatus({ status: "success", test: true }).label).toBe("Finished");
        expect(runStatus({ status: "error", test: false }).label).toBe("Did not finish");
        expect(runStatus({ status: "running", test: false }).label).toBe("Running");
    });
});
describe("nextRun", () => {
    const now = new Date("2026-09-25T20:00:00Z");
    const agent = (over) => ({
        status: "active",
        triggers: [],
        ...over,
    });
    it("paused, unscheduled, soon and tomorrow", () => {
        expect(nextRun(agent({ status: "paused", triggers: [trig({ next_due_at: "2026-09-26T16:00:00Z" })] }), now)).toBe("Paused");
        expect(nextRun(agent({}), now)).toBe("Not scheduled");
        expect(nextRun(agent({ triggers: [trig({ next_due_at: "2026-09-25T20:42:00Z" })] }), now)).toBe("In 42 min");
        expect(nextRun(agent({ triggers: [trig({ next_due_at: "2026-09-26T16:00:00Z" })] }), now)).toBe("Tomorrow, 9:00 AM (PT)");
    });
    it("ignores a disabled trigger", () => {
        expect(nextRun(agent({ triggers: [trig({ enabled: false, next_due_at: "2026-09-26T16:00:00Z" })] }), now)).toBe("Not scheduled");
    });
});
describe("pastWhen", () => {
    it("today / yesterday / a date", () => {
        const now = new Date("2026-09-25T20:00:00Z");
        expect(pastWhen("2026-09-25T16:00:00Z", now, "America/Los_Angeles")).toBe("Today, 9:00 AM");
        expect(pastWhen("2026-09-24T16:00:00Z", now, "America/Los_Angeles")).toBe("Yesterday, 9:00 AM");
        expect(pastWhen("2026-09-22T16:00:00Z", now, "America/Los_Angeles")).toBe("Sep 22, 9:00 AM");
    });
});
describe("receipts", () => {
    it("one plain line per write, grouped by run", () => {
        const rs = [
            { id: "a", run_id: "r1", tool_name: "praxis__action", decision_class: "meta_ads.budget_change", outcome: "succeeded" },
            { id: "b", run_id: "r1", tool_name: "slack__post_message", decision_class: null, outcome: "failed" },
            { id: "c", run_id: null, tool_name: "x", decision_class: null, outcome: "succeeded" },
        ];
        expect(receiptLine(rs[0])).toBe("Meta ads budget change");
        expect(receiptLine(rs[1])).toBe("Post message (did not go through)");
        expect(receiptsByRun(rs).get("r1")?.map((r) => r.id)).toEqual(["a", "b"]);
        expect(receiptsByRun(rs).size).toBe(1);
    });
});
describe("findBuilderAgent", () => {
    it("finds by id or by slug", () => {
        const a = { id: "id-1", slug: "c-abcdefgh01" };
        expect(findBuilderAgent([a], "id-1")).toBe(a);
        expect(findBuilderAgent([a], "c-abcdefgh01")).toBe(a);
        expect(findBuilderAgent([a], "other")).toBeNull();
    });
});
describe("plainRunText links (B3)", () => {
    it("a markdown link becomes its text with the address in brackets", () => {
        expect(plainRunText("[Zavi](https://zaviagent.com) — source: recent runs")).toBe("Zavi (https://zaviagent.com) — source: recent runs");
    });
});
describe("results page helpers", () => {
    it("sends-to says a scheduled result also goes by email, unless it already does", async () => {
        const { sendsResultsLine } = L;
        expect(sendsResultsLine({ kind: "chat_thread", thread_id: "t" })).toBe("This conversation, and by email");
        expect(sendsResultsLine({ kind: "email" })).toBe("Email, to your workspace's recipients");
        expect(sendsResultsLine(null)).toBe("Not delivered anywhere yet");
    });
    it("the result markdown drops a watch's machine block", async () => {
        const { runResultMarkdown } = L;
        expect(runResultMarkdown("Price dropped\n\n```watch_result\n{\"a\":1}\n```\n")).toBe("Price dropped");
    });
});

"use strict";
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
    it.each([null, undefined, "x", {}, { kind: "draft" }, { kind: "draft", draft: { ...draft, triggers: [{ kind: "nope" }] } }])("no card on doubt: %j", (raw) => {
        expect(parseCustomAgentCard(raw)).toBeNull();
    });
});
describe("labels", () => {
    it("names the destination and the trigger", () => {
        expect(deliverLabel({ kind: "email" })).toBe("Email, to your workspace's recipients");
        expect(deliverLabel(null)).toBe("Not delivered anywhere yet");
        expect(deliverLabel({ kind: "telegram", chat_id: 1 })).toBe("Telegram");
        expect(deliverLabel({ kind: "discord", channel_id: "D1", guild_id: "G1" })).toBe("Discord");
        expect(triggerLabel({ kind: "watch", interval_minutes: 15, condition: "pricing changes" })).toBe("Checks every 15 min: pricing changes");
    });
});
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
    it.each(["*/15 9 * * *", "0 */2 * * 1-5", "0 9 1 * *", "0 9 * 1 *", "0 9-17 * * *", "0 9 * * MON", "nonsense", "99 9 * * *"])("falls back for %s", (cron) => {
        expect(scheduleLabel(cron, "UTC")).toBe(`Custom schedule (${cron})`);
    });
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
describe("draftFromServerAgent (reload restores what was created)", () => {
    it("takes every editable field from the server", () => {
        const got = draftFromServerAgent({
            id: "a1",
            status: "active",
            name: "Renamed bot",
            role: "New role",
            instructions: "New instructions",
            triggers: [{ id: "t1", kind: "watch", cron: null, tz: null, interval_minutes: 30, condition: "price changes", enabled: true }],
            deliver: { kind: "email" },
        }, draft);
        expect(got).toMatchObject({
            name: "Renamed bot",
            role: "New role",
            instructions: "New instructions",
            triggers: [{ kind: "watch", interval_minutes: 30, condition: "price changes" }],
            deliver: { kind: "email" },
        });
    });
    it("a cleared destination stays cleared", () => {
        expect(draftFromServerAgent({ id: "a1", status: "active", name: "X", deliver: null }, draft).deliver).toBeNull();
    });
});
