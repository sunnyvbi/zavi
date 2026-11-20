
import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "73db45ff-0000-4000-8000-000000000002";

const askFounderOutsideReview = vi.fn().mockResolvedValue(true);
let objectName = "Rent a car at $35 per day";
vi.mock("../open-advice", () => ({
  refsFromPayload: (p: { ad_set_id?: string }) => ({ ids: p.ad_set_id ? [p.ad_set_id] : [] }),
  adObjectFor: async () => ({ name: objectName, ids: [] }),
  channelsForAdClass: () => ["meta_ads"],
  normName: (s: string) => s.toLowerCase(),
  assertNoContradictingOpenAdvice: vi.fn().mockResolvedValue(true),
  askFounderOutsideReview: (...a: unknown[]) => askFounderOutsideReview(...a),
}));

let liveUsd = 178.8;
vi.mock("../held-order-yes", async (orig) => ({
  ...(await orig<typeof import("../held-order-yes")>()),
  readLiveDailyBudget: async () => ({ usd: liveUsd }),
}));

type Read = { projection: { projected_usd: number; month_cap_usd: number; days_left: number; over: boolean } } | null;
let month: () => Promise<Read> = async () => null;

import { askFounderAboutHeld, heldRaiseCapWarning } from "../unattended-policy";
import { capWarningWords } from "@/services/channels/cap-warning";
import { overProjectionGate } from "@/services/decisions/ad-budget";
overProjectionGate.read = () => month();

const OVER = { projected_usd: 29_225.7, month_cap_usd: 28_400, days_left: 3, over: true };
const rentACar = (to: number, from = 178.8) => ({
  kind: "ad" as const,
  exec_class: "meta_ads.update_ad_set_budget",
  payload: { ad_set_id: "120258729006520059", daily_budget_usd: to, expected_current_daily_budget_usd: from },
  source: { table: "channel_actions" as const, id: "order-key-1", run_id: "run-1" },
  title: "Raise “Rent a car at $35 per day” (ad set 120258729006520059)",
});
const lastCall = () => askFounderOutsideReview.mock.calls.at(-1)![0] as { topic: string; ask: string; on_yes?: { kind: string; to_usd: number; from_usd: number } };

describe("a held raise past the month cap", () => {
  beforeEach(() => {
    askFounderOutsideReview.mockClear();
    objectName = "Rent a car at $35 per day";
    liveUsd = 178.8;
    month = async () => ({ projection: OVER });
  });

  it("Rent a car $178.80 -> $208.34 while October runs over: the ask carries the cap warning and keeps its one-tap yes", async () => {
    await askFounderAboutHeld(T, rentACar(208.34), { verdict: "ask_founder", reasons: ["tracking_broken"] }, false);
    const { ask, on_yes, topic } = lastCall();
    const warning = capWarningWords(OVER, 29.54)!;
    expect(warning).toContain("over your $28,400 cap");
    expect(ask).toContain(warning);
    expect(ask.startsWith("I did not raise “Rent a car at $35 per day” from $178.80 to $208.34 a day on my own: conversion tracking is not working.")).toBe(true);
    expect(ask.endsWith("Should I apply it?")).toBe(true);
    expect(on_yes).toMatchObject({ kind: "held_ad_order", from_usd: 178.8, to_usd: 208.34, cap_warned: true });
    expect(topic).toBe("held:meta_ads:120258729006520059");
  });

  it("a month that stays under the cap with the raise says nothing about the cap", async () => {
    month = async () => ({ projection: { projected_usd: 20_000, month_cap_usd: 28_400, days_left: 3, over: false } });
    await askFounderAboutHeld(T, rentACar(208.34), { verdict: "ask_founder", reasons: ["tracking_broken"] }, false);
    expect(lastCall().ask).not.toMatch(/cap/);
    expect(lastCall().on_yes).not.toHaveProperty("cap_warned");
  });

  it("an unreadable month or no ad budget: no cap words (never a guessed number), and the question is still asked", async () => {
    for (const m of [async (): Promise<Read> => Promise.reject(new Error("counter down")), async (): Promise<Read> => null]) {
      month = m;
      askFounderOutsideReview.mockClear();
      await askFounderAboutHeld(T, rentACar(208.34), { verdict: "ask_founder", reasons: ["tracking_broken"] }, false);
      expect(askFounderOutsideReview).toHaveBeenCalledTimes(1);
      expect(lastCall().ask).not.toMatch(/cap/);
      expect(lastCall().on_yes).toMatchObject({ kind: "held_ad_order" });
    }
  });

  it("must-not: a held CUT on the founder's own budget is still asked, with no cap words, by its cleaned name", async () => {
    objectName = "Zavi · Regular Leads - Ad set (copy) · zv5dea8ca411";
    const cut = { ...rentACar(64, 80), payload: { ad_set_id: "120260836219200059", daily_budget_usd: 64, expected_current_daily_budget_usd: 80 } };
    liveUsd = 80;
    await askFounderAboutHeld(T, cut, { verdict: "ask_founder", reasons: ["founder_set_budget|outside|2026-10-11|meta|", "tracking_broken"] }, false);
    const { ask } = lastCall();
    expect(ask.startsWith("I did not cut “Regular Leads - Ad set (copy)” from $80 to $64 a day on my own: you changed its budget in Ads Manager on Oct 11; conversion tracking is not working.")).toBe(true);
    expect(ask).not.toMatch(/Zavi ·|zv5dea8ca411|cap/);
  });

  it("heldRaiseCapWarning: only a raise is priced, never a cut or a flat change", async () => {
    expect(await heldRaiseCapWarning(T, { daily_budget_usd: 208.34, expected_current_daily_budget_usd: 178.8 })).toBe(capWarningWords(OVER, 29.54));
    expect(await heldRaiseCapWarning(T, { daily_budget_usd: 64, expected_current_daily_budget_usd: 80 })).toBeNull();
    expect(await heldRaiseCapWarning(T, { daily_budget_usd: 80, expected_current_daily_budget_usd: 80 })).toBeNull();
    expect(await heldRaiseCapWarning(T, { daily_budget_usd: 80 })).toBeNull();
  });
});
