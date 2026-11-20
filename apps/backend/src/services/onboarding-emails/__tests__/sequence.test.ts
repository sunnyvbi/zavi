
import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = vi.hoisted(() => ({ enabled: true }));
const db = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  upserts: [] as Array<Record<string, unknown>>,
  upsertResult: null as null | { data: unknown; error: { message: string; code?: string } | null },
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => settings.enabled),
  getBoolSettingStrict: vi.fn(async () => false),
}));
vi.mock("@/services/web-base", () => ({
  webBaseUrl: () => "https://www.zaviagent.com",
  workspaceUrl: () => "https://www.zaviagent.com/workspace",
}));
vi.mock("@/email/sendAuthEmail", () => ({
  resolveSequenceRecipient: vi.fn(),
  sendOnboardingSequenceEmail: vi.fn(),
}));
vi.mock("@/services/tenant-client", () => {
  const chain = (table: string): unknown => {
    let single = false;
    let upserted = false;
    const result = () =>
      (upserted && db.upsertResult) ||
      ((single ? db.tables[`${table}:single`] : undefined) ?? db.tables[table] ?? { data: [], error: null });
    const p: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lte", "gte", "is", "not", "like", "order", "limit", "in", "update"]) {
      p[m] = () => p;
    }
    p.maybeSingle = () => ((single = true), p);
    p.upsert = (row: Record<string, unknown>) => (db.upserts.push(row), (upserted = true), p);
    p.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    return p;
  };
  return {
    asTenantId: (s: string) => s,
    tenantClient: () => ({ from: (t: string) => chain(t) }),
    staffCrossTenantClient: () => ({ from: (t: string) => chain(t) }),
    onboardingEmailRpc: vi.fn(async () => ({ data: true, error: null })),
  };
});

import { resolveSequenceRecipient, sendOnboardingSequenceEmail } from "@/email/sendAuthEmail";
import {
  enrolAndSendFirst,
  enrolFromDayOne,
  sendNextStep,
  sweepDueSequences,
  unsubscribeUrlFor,
  type SequenceRow,
} from "../sequence";
import { EmailNotSentError } from "../send-errors";
import { loadWorkspaceFacts, upgradeEmailAlreadySent, type WorkspaceFacts, type EmailCard } from "../facts";

const T0 = new Date("2026-10-05T10:00:00Z");
const DAY = 86_400_000;

function row(over: Partial<SequenceRow> = {}): SequenceRow {
  return {
    id: "row-1",
    tenant_id: "tenant-1",
    user_id: "user-1",
    unsub_token: "33333333-3333-4333-8333-333333333333",
    started_at: T0.toISOString(),
    last_step: 0,
    last_sent_at: null,
    next_due_at: T0.toISOString(),
    status: "active",
    sent_steps: [],
    skipped_steps: [],
    channel_order: null,
    wait_since: null,
    digest_until: null,
    ...over,
  };
}

const sentRow = (sent: number[], over: Partial<SequenceRow> = {}) =>
  row({ sent_steps: sent, last_step: sent[sent.length - 1] ?? 0, last_sent_at: new Date(T0.getTime() - DAY).toISOString(), ...over });

function card(over: Partial<EmailCard> = {}): EmailCard {
  return {
    id: "card-1",
    channel_slug: "reddit_organic",
    title: "Answer the r/smallbusiness thread on invoicing",
    reason: "Three people asked this week which tool handles late payments.",
    blocking: false,
    position: 1,
    score: 50,
    proposed_at: T0.toISOString(),
    status: "pending",
    snoozed_until: null,
    action_type: null,
    ...over,
  };
}

function wsFacts(cards: EmailCard[] = [], over: Partial<WorkspaceFacts["plan"]> = {}): WorkspaceFacts {
  const by = new Map<string, EmailCard[]>();
  for (const c of cards) by.set(c.channel_slug, [...(by.get(c.channel_slug) ?? []), c]);
  return {
    company: "Acme",
    cards: by,
    plan: {
      openCards: new Map([...by].map(([k, v]) => [k, v.length])),
      used: new Set(),
      inFlight: new Set(),
      upgradeEmailSent: false,
      paidRerunsInFlight: false,
      ...over,
    },
  };
}

function fakeDeps(over: Record<string, unknown> = {}) {
  return {
    resolveRecipient: vi.fn(async () => ({ email: "priya@acme.com", verified: true, name: "Priya Nair" })),
    send: vi.fn(async () => {}),
    claimStep: vi.fn(async () => true),
    releaseStep: vi.fn(async () => {}),
    defer: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    facts: vi.fn(async () => wsFacts()),
    planIncludes: vi.fn(async () => false),
    links: () => ({ workspaceUrl: "https://www.zaviagent.com/workspace", imageBaseUrl: "https://www.zaviagent.com" }),
    stillEnabled: vi.fn(async () => true),
    claimResultsEmail: vi.fn(async () => true),
    releaseResultsEmail: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(sendOnboardingSequenceEmail).mockClear();
  settings.enabled = true;
  db.tables = {};
  db.upserts = [];
  db.upsertResult = null;
});

describe("sendNextStep", () => {
  it("sends the next email, greeting the person by their own name", async () => {
    const deps = fakeDeps();
    const r = await sendNextStep(sentRow([1]), T0, deps);
    expect(r).toBe("sent");
    expect(deps.claimStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: "row-1" }),
      expect.objectContaining({ step: 2, skip: [10], nextDue: expect.any(Date) }),
    );
    const sent = (deps.send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(sent.to).toBe("priya@acme.com");
    expect(sent.firstName).toBe("Priya");
    expect((sent.step as { step: number }).step).toBe(2);
    expect(sent.unsubscribeUrl).toBe(unsubscribeUrlFor("33333333-3333-4333-8333-333333333333"));
  });

  it("claims the step BEFORE sending it", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      claimStep: vi.fn(async () => (order.push("claim"), true)),
      send: vi.fn(async () => void order.push("send")),
    });
    await sendNextStep(row(), T0, deps);
    expect(order).toEqual(["claim", "send"]);
  });

  it("sends nothing when another sweep already took the step", async () => {
    const deps = fakeDeps({ claimStep: vi.fn(async () => false) });
    expect(await sendNextStep(row(), T0, deps)).toBe("lost_race");
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("does not mail an address that was never verified, and leaves the step due", async () => {
    const deps = fakeDeps({ resolveRecipient: vi.fn(async () => ({ email: "a@b.co", verified: false, name: null })) });
    expect(await sendNextStep(row(), T0, deps)).toBe("waiting_unverified");
    expect(deps.claimStep).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("stops the sequence for a user with no address", async () => {
    const deps = fakeDeps({ resolveRecipient: vi.fn(async () => null) });
    expect(await sendNextStep(row(), T0, deps)).toBe("no_address");
    expect(deps.stop).toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("when SendGrid REJECTS the send (an HTTP answer), gives the step back so it is retried", async () => {
    const rejection = Object.assign(new Error("Bad Request"), { code: 400, response: { body: { errors: [] }, headers: {} } });
    const deps = fakeDeps({
      send: vi.fn(async () => {
        throw rejection;
      }),
    });
    const r = await sendNextStep(sentRow([1, 2, 3]), T0, deps);
    expect(r).toBe("failed");
    expect(deps.releaseStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: "row-1" }),
      expect.objectContaining({ step: 4 }),
      "Bad Request",
    );
  });

  it("an email that failed before it was sent is given back too", async () => {
    const deps = fakeDeps({
      send: vi.fn(async () => {
        throw new EmailNotSentError("render failed");
      }),
    });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("failed");
    expect(deps.releaseStep).toHaveBeenCalled();
  });

  it("a timeout or network error keeps the claim: the email is never sent twice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const err of [new Error("socket hang up"), Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })]) {
      const deps = fakeDeps({
        send: vi.fn(async () => {
          throw err;
        }),
      });
      expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("unconfirmed");
      expect(deps.releaseStep).not.toHaveBeenCalled();
    }
    warn.mockRestore();
  });

  it("completes the row once every email has been sent", async () => {
    const deps = fakeDeps();
    const r = sentRow([1, 2, 3, 4, 6, 7, 8, 9], { skipped_steps: [10] });
    expect(await sendNextStep(r, T0, deps)).toBe("over");
    expect(deps.complete).toHaveBeenCalled();
    expect(deps.resolveRecipient).not.toHaveBeenCalled();
    expect(deps.claimStep).not.toHaveBeenCalled();
  });

  it("a welcome reads nothing about the workspace", async () => {
    const deps = fakeDeps();
    await sendNextStep(row(), T0, deps);
    expect(deps.facts).not.toHaveBeenCalled();
    expect((deps.claimStep.mock.calls[0] as unknown[])[1]).toMatchObject({ step: 1 });
  });

  it("day 1 with cards sends the digest with the workspace's real cards", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()])) });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("sent");
    expect((deps.claimStep.mock.calls[0] as unknown[])[1]).toMatchObject({ step: 10, skip: [2] });
    const sent = (deps.send.mock.calls[0] as unknown[])[0] as { step: { step: number }; results: { subject: string; items: Array<{ title: string }> } };
    expect(sent.step.step).toBe(10);
    expect(sent.results.subject).toBe("Your first results for Acme: 1 step ready");
    expect(sent.results.items[0].title).toBe("Answer the r/smallbusiness thread on invoicing");
  });

  it("a channel email with cards: results version, Starter line when the plan lacks the channel", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card(), card({ id: "card-2", title: "Second" })])) });
    expect(await sendNextStep(sentRow([1, 10], { skipped_steps: [2] }), T0, deps)).toBe("sent");
    const c = (deps.claimStep.mock.calls[0] as unknown[])[1] as { step: number; channelOrder: number[] };
    expect(c.step).toBe(6);
    expect(c.channelOrder).toEqual([6, 3, 4, 7]);
    const sent = (deps.send.mock.calls[0] as unknown[])[0] as { results: { afterButton: string; ctaUrl: string } };
    expect(sent.results.afterButton).toMatch(/^The drafts are yours to copy and post/);
    expect(sent.results.ctaUrl).toBe("https://www.zaviagent.com/workspace?tab=channels&channel=reddit_organic&action=card-1&src=onb_6");
  });

  it("a channel email lets its channels' held signup cards out before it is built and sent", async () => {
    const releaseHeld = vi.fn(async () => 2);
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card({ held: true, status: "snoozed" })])), releaseHeld });
    expect(await sendNextStep(sentRow([1, 10], { skipped_steps: [2] }), T0, deps)).toBe("sent");
    expect(releaseHeld).toHaveBeenCalledWith("tenant-1", ["reddit_organic"]);
    expect(releaseHeld.mock.invocationCallOrder[0]).toBeLessThan(deps.send.mock.invocationCallOrder[0]);
    const sent = (deps.send.mock.calls[0] as unknown[])[0] as { results: { ctaUrl: string } };
    expect(sent.results.ctaUrl).toContain("action=card-1");
  });

  it("a failed release sends nothing and claims nothing (the next sweep retries); the digest releases nothing", async () => {
    const releaseHeld = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card({ held: true, status: "snoozed" })])), releaseHeld });
    await expect(sendNextStep(sentRow([1, 10], { skipped_steps: [2] }), T0, deps)).rejects.toThrow("rpc down");
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.claimStep).not.toHaveBeenCalled();
    const digestRelease = vi.fn(async () => 0);
    const digest = fakeDeps({ facts: vi.fn(async () => wsFacts([card()])), releaseHeld: digestRelease });
    await sendNextStep(sentRow([1]), T0, digest);
    expect(digestRelease).not.toHaveBeenCalled();
  });

  it("the plan includes the channel: 'Nothing posts until you approve it.'", async () => {
    const deps = fakeDeps({
      facts: vi.fn(async () => wsFacts([card()])),
      planIncludes: vi.fn(async () => true),
    });
    await sendNextStep(sentRow([1, 10], { skipped_steps: [2] }), T0, deps);
    const sent = (deps.send.mock.calls[0] as unknown[])[0] as { results: { afterButton: string } };
    expect(sent.results.afterButton).toBe("Nothing posts until you approve it.");
  });

  it("a stored channel order is never re-sent to the claim", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()])) });
    await sendNextStep(sentRow([1, 10], { skipped_steps: [2], channel_order: [3, 4, 6, 7] }), T0, deps);
    expect((deps.claimStep.mock.calls[0] as unknown[])[1]).toMatchObject({ step: 3, channelOrder: null });
  });

  it("waiting for a running onboarding run defers the row, sends nothing", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([], { inFlight: new Set(["seo"]) })) });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("waiting");
    expect(deps.defer).toHaveBeenCalledWith(expect.objectContaining({ id: "row-1" }), expect.any(Date), true, T0);
    expect(deps.claimStep).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("only skips NEW to the row go to the claim (so a release removes exactly those)", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([], { used: new Set(["seo", "geo"]) })) });
    await sendNextStep(sentRow([1, 2], { skipped_steps: [10] }), T0, deps);
    expect((deps.claimStep.mock.calls[0] as unknown[])[1]).toMatchObject({ step: 4, skip: [3] });
  });

  it("falls back to 'there' when the profile has no name", async () => {
    const deps = fakeDeps({ resolveRecipient: vi.fn(async () => ({ email: "a@b.co", verified: true, name: null })) });
    await sendNextStep(row(), T0, deps);
    expect(((deps.send.mock.calls[0] as unknown[])[0] as { firstName: string }).firstName).toBe("there");
  });
});

describe("one email only: the upgrade email already went", () => {
  it("day 1 with cards: Growth Strategy, never the digest, and 10 recorded skipped", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()], { upgradeEmailSent: true })) });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("sent");
    expect((deps.claimStep.mock.calls[0] as unknown[])[1]).toMatchObject({ step: 2, skip: [10] });
    const sent = (deps.send.mock.calls[0] as unknown[])[0] as { step: { step: number }; results?: unknown };
    expect(sent.step.step).toBe(2);
    expect(sent.results).toBeUndefined();
  });

  it("a person enrolled before the digest: their next email goes, the digest is skipped", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()], { upgradeEmailSent: true })) });
    const r = sentRow([1, 2, 3], { digest_until: new Date(T0.getTime() + 30 * DAY).toISOString() });
    expect(await sendNextStep(r, T0, deps)).toBe("sent");
    const c = (deps.claimStep.mock.calls[0] as unknown[])[1] as { step: number; skip: number[] };
    expect(c.step).not.toBe(10);
    expect(c.skip).toContain(10);
  });

  it("a person enrolled before the digest with nothing left: completes with 10 skipped", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()], { upgradeEmailSent: true })) });
    const r = sentRow([1, 2, 3, 4, 6, 7, 8, 9], { digest_until: new Date(T0.getTime() + 30 * DAY).toISOString() });
    expect(await sendNextStep(r, T0, deps)).toBe("over");
    expect(deps.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "row-1" }), [10], T0);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("the flag is read through facts: an unreadable flag counts as sent (never two results emails)", async () => {
    expect(await upgradeEmailAlreadySent("tenant-1", async () => { throw new Error("db down"); })).toBe(true);
    expect(await upgradeEmailAlreadySent("tenant-1", async () => false)).toBe(false);
    expect(await upgradeEmailAlreadySent("tenant-1", async () => true)).toBe(true);
    const read = vi.fn(async () => { throw new Error("db down"); });
    const f = await loadWorkspaceFacts("tenant-1", T0.toISOString(), T0, { readUpgradeEmailSent: read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("tenant-1");
    expect(f.plan.upgradeEmailSent).toBe(true);
    const deps = fakeDeps({ facts: vi.fn(async () => ({ ...wsFacts([card()]), plan: { ...wsFacts([card()]).plan, upgradeEmailSent: f.plan.upgradeEmailSent } })) });
    await sendNextStep(sentRow([1]), T0, deps);
    expect((deps.claimStep.mock.calls[0] as unknown[])[1]).toMatchObject({ step: 2, skip: [10] });
  });

  it("the tier is read only while a preview-key run is still going", async () => {
    const isPaid = vi.fn(async () => true);
    const idle = await loadWorkspaceFacts("tenant-1", T0.toISOString(), T0, { readUpgradeEmailSent: async () => false, isPaid });
    expect(isPaid).not.toHaveBeenCalled();
    expect(idle.plan.paidRerunsInFlight).toBe(false);
    db.tables["agent_runs"] = { data: [{ agent_slug: "seo", status: "running", channel_slug: null }], error: null };
    const busy = await loadWorkspaceFacts("tenant-1", T0.toISOString(), T0, { readUpgradeEmailSent: async () => false, isPaid });
    expect(isPaid).toHaveBeenCalledWith("tenant-1");
    expect(busy.plan.paidRerunsInFlight).toBe(true);
  });

  it("the flag reads false by default: the digest still goes to a workspace that never upgraded", async () => {
    const f = await loadWorkspaceFacts("tenant-1", T0.toISOString(), T0, { readUpgradeEmailSent: async () => false });
    expect(f.plan.upgradeEmailSent).toBe(false);
  });
});

describe("one results email: the digest claims it first", () => {
  it("a digest claims the workspace's results email before it is sent", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()])) });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("sent");
    expect(deps.claimResultsEmail).toHaveBeenCalledWith("tenant-1");
    expect(deps.claimResultsEmail.mock.invocationCallOrder[0]).toBeLessThan(deps.claimStep.mock.invocationCallOrder[0]);
    expect((deps.claimStep.mock.calls[0] as unknown[])[1]).toMatchObject({ step: 10 });
    expect(deps.releaseResultsEmail).not.toHaveBeenCalled();
  });

  it("the actions-ready email went first (claim lost): Growth Strategy goes, 10 skipped", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()])), claimResultsEmail: vi.fn(async () => false) });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("sent");
    expect((deps.claimStep.mock.calls[0] as unknown[])[1]).toMatchObject({ step: 2, skip: [10] });
    expect(((deps.send.mock.calls[0] as unknown[])[0] as { step: { step: number } }).step.step).toBe(2);
  });

  it("claim lost for a finished person enrolled before the digest: completes with 10 skipped", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()])), claimResultsEmail: vi.fn(async () => false) });
    const r = sentRow([1, 2, 3, 4, 6, 7, 8, 9], { digest_until: new Date(T0.getTime() + 30 * DAY).toISOString() });
    expect(await sendNextStep(r, T0, deps)).toBe("over");
    expect(deps.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "row-1" }), [10], T0);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("a definite rejection of the digest gives the results claim back", async () => {
    const deps = fakeDeps({
      facts: vi.fn(async () => wsFacts([card()])),
      send: vi.fn(async () => {
        throw Object.assign(new Error("Bad Request"), { code: 400, response: { body: {} } });
      }),
    });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("failed");
    expect(deps.releaseResultsEmail).toHaveBeenCalledWith("tenant-1");
  });

  it("an uncertain digest failure keeps the claim (never twice)", async () => {
    const deps = fakeDeps({
      facts: vi.fn(async () => wsFacts([card()])),
      send: vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      }),
    });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("unconfirmed");
    expect(deps.releaseResultsEmail).not.toHaveBeenCalled();
  });

  it("losing the step to another sweep gives the claim back", async () => {
    const deps = fakeDeps({ facts: vi.fn(async () => wsFacts([card()])), claimStep: vi.fn(async () => false) });
    expect(await sendNextStep(sentRow([1]), T0, deps)).toBe("lost_race");
    expect(deps.releaseResultsEmail).toHaveBeenCalledWith("tenant-1");
  });

  it("a step-claim error gives the results claim back before rethrowing", async () => {
    const deps = fakeDeps({
      facts: vi.fn(async () => wsFacts([card()])),
      claimStep: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    await expect(sendNextStep(sentRow([1]), T0, deps)).rejects.toThrow("rpc down");
    expect(deps.releaseResultsEmail).toHaveBeenCalledWith("tenant-1");
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("a non-digest email never touches the results claim", async () => {
    const deps = fakeDeps();
    await sendNextStep(sentRow([1, 2], { skipped_steps: [10] }), T0, deps);
    expect(deps.claimResultsEmail).not.toHaveBeenCalled();
  });
});

describe("enrolAndSendFirst", () => {
  it("does nothing, and says so, while the switch is off", async () => {
    settings.enabled = false;
    expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(false);
  });

  it("while the switch is off, someone who opted out earlier still gets no old welcome", async () => {
    settings.enabled = false;
    db.tables.onboarding_email_sequence = { data: [{ id: "old" }], error: null };
    expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(true);
    expect(db.upserts).toEqual([]);
  });

  it("a dogfood workspace is never enrolled, and email 1 is not sent", async () => {
    for (const slug of ["upcar-ai", "upcar-private", "apna-tutor-dogfood"]) {
      db.upserts = [];
      db.tables.onboarding_email_sequence = { data: [], error: null };
      db.tables.tenants = { data: { slug, kind: "real", deleted_at: null }, error: null };
      expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(true);
      expect(db.upserts).toEqual([]);
    }
    expect(sendOnboardingSequenceEmail).not.toHaveBeenCalled();
  });

  it("once the row exists, a failed email 1 is left to the sweep, not the old welcome", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.tables.onboarding_email_sequence = { data: [], error: null };
    db.tables["onboarding_email_sequence:single"] = { data: row({ tenant_id: "t", user_id: "u" }), error: null };
    vi.mocked(resolveSequenceRecipient).mockRejectedValueOnce(new Error("auth admin down"));
    expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(true);
    expect(db.upserts).toHaveLength(1);
    expect(sendOnboardingSequenceEmail).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a person who opted out in another workspace gets nothing, not even the old welcome", async () => {
    db.tables.onboarding_email_sequence = {
      data: [{ id: "old", tenant_id: "other", status: "unsubscribed" }],
      error: null,
    };
    expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(true);
    expect(db.upserts).toEqual([]);
    expect(sendOnboardingSequenceEmail).not.toHaveBeenCalled();
  });

  it("a second workspace for the same person does not start a second sequence", async () => {
    db.tables.onboarding_email_sequence = {
      data: [{ id: "first", tenant_id: "other", status: "active" }],
      error: null,
    };
    expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(true);
    expect(db.upserts).toEqual([]);
    expect(sendOnboardingSequenceEmail).not.toHaveBeenCalled();
  });

  it("the one-live-sequence-per-person index refusing the insert = already enrolled: nothing sent", async () => {
    db.tables.onboarding_email_sequence = { data: [], error: null };
    db.upsertResult = { data: null, error: { message: "duplicate key value", code: "23505" } };
    expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(true);
    expect(sendOnboardingSequenceEmail).not.toHaveBeenCalled();
  });

  it("a stopped sequence elsewhere does not block this workspace", async () => {
    db.tables.onboarding_email_sequence = {
      data: [{ id: "dead", tenant_id: "other", status: "stopped" }],
      error: null,
    };
    await enrolAndSendFirst({ tenant_id: "t", user_id: "u" });
    expect(db.upserts).toHaveLength(1);
  });

  it("a retried activate for the same workspace still works (no second welcome)", async () => {
    db.tables.onboarding_email_sequence = {
      data: [{ id: "mine", tenant_id: "t", status: "active", last_step: 1 }],
      error: null,
    };
    expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(true);
    expect(sendOnboardingSequenceEmail).not.toHaveBeenCalled();
  });

  it("a test or deleted workspace is never enrolled, and email 1 is not sent", async () => {
    for (const tenant of [{ kind: "test", deleted_at: null }, { kind: null, deleted_at: "2026-10-01T00:00:00Z" }]) {
      db.upserts = [];
      db.tables.onboarding_email_sequence = { data: [], error: null };
      db.tables.tenants = { data: tenant, error: null };
      expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(true);
      expect(db.upserts).toEqual([]);
    }
    expect(sendOnboardingSequenceEmail).not.toHaveBeenCalled();
  });

  it("never throws: a database error means 'fall back to the old welcome'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.tables.onboarding_email_sequence = { data: null, error: { message: "db down" } };
    expect(await enrolAndSendFirst({ tenant_id: "t", user_id: "u" })).toBe(false);
    warn.mockRestore();
  });
});

describe("enrolFromDayOne (fresh-build signups)", () => {
  it("does nothing while the switch is off", async () => {
    settings.enabled = false;
    expect(await enrolFromDayOne({ tenant_id: "t", user_id: "u" })).toBe(false);
    expect(db.upserts).toEqual([]);
  });

  it("joins at email 2: email 1 counts as sent, the next is due in a day", async () => {
    db.tables.onboarding_email_sequence = { data: [], error: null };
    const before = Date.now();
    await enrolFromDayOne({ tenant_id: "t", user_id: "u" });
    expect(db.upserts).toHaveLength(1);
    const row = db.upserts[0] as { user_id: string; last_step: number; next_due_at: string };
    expect(row.user_id).toBe("u");
    expect(row.last_step).toBe(1);
    expect((row as unknown as { sent_steps: number[] }).sent_steps).toEqual([1]);
    const due = Date.parse(row.next_due_at);
    expect(due).toBeGreaterThanOrEqual(before + DAY - 1000);
    expect(due).toBeLessThanOrEqual(Date.now() + DAY + 1000);
  });

  it("a normal signup (activate) is enrolled with no steps sent, so email 1 goes first", async () => {
    db.tables.onboarding_email_sequence = { data: [], error: null };
    await enrolAndSendFirst({ tenant_id: "t", user_id: "u" });
    expect(db.upserts[0]).toEqual({ user_id: "u" });
  });

  it("never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.tables.onboarding_email_sequence = { data: null, error: { message: "db down" } };
    expect(await enrolFromDayOne({ tenant_id: "t", user_id: "u" })).toBe(false);
    warn.mockRestore();
  });
});

describe("sweepDueSequences", () => {
  it("sends nothing while the switch is off", async () => {
    settings.enabled = false;
    expect(await sweepDueSequences(T0, fakeDeps())).toEqual({ skipped: "disabled" });
  });

  it("sends what is due, and stops test and deleted workspaces instead of mailing them", async () => {
    db.tables.onboarding_email_sequence = {
      data: [
        sentRow([1], { id: "live", tenant_id: "t-live" }),
        row({ id: "test", tenant_id: "t-test" }),
        row({ id: "dog", tenant_id: "t-dog" }),
      ],
      error: null,
    };
    db.tables.tenants = {
      data: [
        { id: "t-live", kind: null, deleted_at: null },
        { id: "t-test", kind: "test", deleted_at: null },
        { id: "t-dog", slug: "upcar-ai", kind: "real", deleted_at: null },
      ],
      error: null,
    };
    const deps = fakeDeps();
    const out = await sweepDueSequences(T0, deps);
    expect(out).toEqual({ examined: 3, sent: 1, failed: 0, stopped: 2, other: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.stop).toHaveBeenCalledWith(expect.objectContaining({ id: "test" }));
    expect(deps.stop).toHaveBeenCalledWith(expect.objectContaining({ id: "dog" }));
  });

  it("turning the switch off stops a sweep that is already running", async () => {
    db.tables.onboarding_email_sequence = {
      data: [row({ id: "a", user_id: "ua" }), row({ id: "b", user_id: "ub" }), row({ id: "c", user_id: "uc" })],
      error: null,
    };
    db.tables.tenants = { data: [{ id: "tenant-1", kind: null, deleted_at: null }], error: null };
    const deps = fakeDeps({
      stillEnabled: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    });
    const out = await sweepDueSequences(T0, deps);
    expect(out).toMatchObject({ sent: 1 });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("an unreadable switch counts as off: nothing is sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.tables.onboarding_email_sequence = { data: [row()], error: null };
    db.tables.tenants = { data: [{ id: "tenant-1", kind: null, deleted_at: null }], error: null };
    const deps = fakeDeps({ stillEnabled: vi.fn().mockRejectedValue(new Error("db down")) });
    const out = await sweepDueSequences(T0, deps);
    expect(out).toMatchObject({ sent: 0 });
    expect(deps.send).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("one person's failure does not stop the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.tables.onboarding_email_sequence = {
      data: [row({ id: "a", user_id: "ua" }), row({ id: "b", user_id: "ub" })],
      error: null,
    };
    db.tables.tenants = { data: [{ id: "tenant-1", kind: null, deleted_at: null }], error: null };
    const deps = fakeDeps({
      resolveRecipient: vi
        .fn()
        .mockRejectedValueOnce(new Error("auth down"))
        .mockResolvedValueOnce({ email: "b@b.co", verified: true, name: "Bo" }),
    });
    const out = await sweepDueSequences(T0, deps);
    expect(out).toMatchObject({ sent: 1, failed: 1 });
    warn.mockRestore();
  });
});
