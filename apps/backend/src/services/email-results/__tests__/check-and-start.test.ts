import { describe, expect, it } from "vitest";
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { EmailToolError, type ProviderCall } from "@/services/connectors/email-campaign/providers";
import { backoffMs, bulkNumbers, runEmailResultsPass, type CheckDeps, type ClaimedTask, type Completion } from "../check";
import { legacyProviderGroup, providerGroup, rowFromCard, startEmailSendResult, type StartDeps } from "../start";
import { shaOf } from "@/services/email-cards/variants";

const T = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-20T12:00:00Z");

const task = (over: Partial<ClaimedTask> = {}): ClaimedTask => ({
  task_id: `task-${Math.random().toString(36).slice(2)}`,
  lease_token: "lease",
  tenant_id: T,
  source: "provider",
  stage: "d7",
  state: "pending",
  attempts: 0,
  group_key: "mailchimp:acct-1",
  give_up_at: "2026-10-30T00:00:00Z",
  result_id: "r1",
  rail: "channel_actions",
  card_id: "c1",
  route: "mailchimp",
  provider_ref: "camp-1",
  account_ref: { kind: "composio", connected_account_id: "acct-1", auth_config_id: "ac" },
  campaign_title: "Zavi: Spring (c1)",
  campaign_slug: "spring-20261012-abcdefghij",
  started_at: "2026-10-12T15:00:00Z",
  finished_at: "2026-10-12T15:00:00Z",
  ga_property_id: null,
  ga_timezone: null,
  ...over,
});

const ok = (data: unknown): ComposioExecResult => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });

function harness(tasks: ClaimedTask[], over: Partial<CheckDeps> = {}) {
  const done: Array<{ t: ClaimedTask; c: Completion }> = [];
  const logs: string[] = [];
  const calls: string[] = [];
  const mailchimpCall: ProviderCall = async (slug) => {
    calls.push(slug);
    if (slug === "MAILCHIMP_GET_CAMPAIGN_REPORT") return ok({ data: { emails_sent: 100, unsubscribed: 1, bounces: { hard_bounces: 2 }, opens: { unique_opens: 30 }, clicks: { unique_subscriber_clicks: 4 } } });
    if (slug === "MAILCHIMP_GET_CAMPAIGN_INFO") return ok({ data: { id: "camp-1", status: "sent", settings: { title: "Zavi: Spring (c1)" }, recipients: { list_id: "L" } } });
    return ok({});
  };
  const deps: CheckDeps = {
    claim: async () => tasks,
    complete: async (t, c) => {
      done.push({ t, c });
    },
    providerAccess: async () => ({ kind: "ok", call: mailchimpCall, sameCredential: true, cacheKey: "k" }),
    bulkCounts: async () => null,
    gaCreds: async () => null,
    gaReport: async () => ({}),
    missing: async () => [],
    start: async () => ({ started: false }),
    holdRepair: async () => undefined,
    backlog: async () => ({ due: 0, oldest_due_at: null, newly_stuck: [] }),
    purgeEventIds: async () => 0,
    alertStuck: async () => undefined,
    log: async (_l, code) => {
      logs.push(code);
    },
    now: () => NOW,
    ...over,
  };
  return { deps, done, logs, calls };
}

describe("email results pass: provider check-backs", () => {
  it("numbers from the tool, nulls kept", async () => {
    const h = harness([task()]);
    await runEmailResultsPass(h.deps);
    expect(h.done[0].c).toEqual({ outcome: "done", result: { recipients: 100, delivered: 98, bounces: 2, opens: 30, clicks: 4, unsubscribes: 1 } });
  });

  it("Mailchimp soft bounces are not delivered: campaign 54d23cdc92 sent 2, 0 hard, 1 soft stores delivered 1 and bounces 1", async () => {
    const report = { emails_sent: 2, unsubscribed: 0, bounces: { hard_bounces: 0, soft_bounces: 1, syntax_errors: 0 }, opens: { unique_opens: 1, open_rate: 1 }, clicks: { unique_subscriber_clicks: 0, click_rate: 0 } };
    const call: ProviderCall = async (slug) => (slug === "MAILCHIMP_GET_CAMPAIGN_REPORT" ? ok({ data: report }) : ok({ data: { id: "54d23cdc92", status: "sent", settings: { title: "Zavi: Spring (c1)" }, recipients: { list_id: "L" } } }));
    const h = harness([task({ stage: "h1", provider_ref: "54d23cdc92" }), task({ stage: "d7", provider_ref: "54d23cdc92" })], {
      providerAccess: async () => ({ kind: "ok", call, sameCredential: true, cacheKey: "k" }),
    });
    await runEmailResultsPass(h.deps);
    expect(h.done).toHaveLength(2);
    for (const d of h.done) {
      expect(d.c).toEqual({ outcome: "done", result: { recipients: 2, delivered: 1, bounces: 1, opens: 1, clicks: 0, unsubscribes: 0 } });
    }
  });

  it("not connected any more: a proven disconnect, not a retry", async () => {
    const h = harness([task()], { providerAccess: async () => ({ kind: "none" }) });
    await runEmailResultsPass(h.deps);
    expect(h.done[0].c).toMatchObject({ outcome: "disconnected", note: "Mailchimp was disconnected; numbers stopped at 1 hour." });
  });

  it("a connection read that failed is a retry with backoff, never a disconnect", async () => {
    const h = harness([task({ attempts: 2 })], {
      providerAccess: async () => {
        throw new Error("connector_metadata read failed");
      },
    });
    await runEmailResultsPass(h.deps);
    expect(h.done[0].c.outcome).toBe("retry");
    expect(h.done[0].c.next_due!.getTime()).toBe(NOW.getTime() + backoffMs(2));
  });

  it("a reconnect reads on only after proving it is our campaign by id and name", async () => {
    const same = harness([task()], { providerAccess: async () => ({ kind: "ok", call: (await harness([]).deps.providerAccess(T, "mailchimp", null) as { call: ProviderCall }).call, sameCredential: false, cacheKey: "k" }) });
    await runEmailResultsPass(same.deps);
    expect(same.done[0].c.outcome).toBe("done");

    const other: ProviderCall = async (slug) =>
      slug === "MAILCHIMP_GET_CAMPAIGN_INFO" ? ok({ data: { id: "camp-1", status: "sent", settings: { title: "Somebody else's" }, recipients: { list_id: "L" } } }) : ok({});
    const h = harness([task()], { providerAccess: async () => ({ kind: "ok", call: other, sameCredential: false, cacheKey: "k" }) });
    await runEmailResultsPass(h.deps);
    expect(h.done[0].c).toMatchObject({ outcome: "disconnected", note: "Mailchimp is connected to a different account now; numbers stopped at 1 hour." });
  });

  it("a 429 waits as asked and spends no attempt; a 404 gives up with a note", async () => {
    const limited: ProviderCall = async () => ({ ok: false, status: 429, data: null, error: "slow down", outcome_unknown: false });
    const h = harness([task()], { providerAccess: async () => ({ kind: "ok", call: limited, sameCredential: true, cacheKey: "k" }) });
    await runEmailResultsPass(h.deps);
    expect(h.done[0].c).toMatchObject({ outcome: "rate_limited" });
    expect(h.done[0].c.next_due!.getTime()).toBe(NOW.getTime() + 120_000);

    const gone: ProviderCall = async () => ({ ok: false, status: 404, data: null, error: "Resource Not Found", outcome_unknown: false });
    const g = harness([task({ stage: "h1" })], { providerAccess: async () => ({ kind: "ok", call: gone, sameCredential: true, cacheKey: "k" }) });
    await runEmailResultsPass(g.deps);
    expect(g.done[0].c).toMatchObject({ outcome: "gave_up", note: "This email is no longer in Mailchimp; numbers stopped before the 1-hour check." });
  });

  it("Klaviyo: one values report for every due campaign of the account; one not in the report waits", async () => {
    const reports: unknown[] = [];
    const k: ProviderCall = async (slug, args) => {
      if (slug === "KLAVIYO_GET_METRICS") return ok({ data: [{ id: "M1" }] });
      reports.push(args.data__attributes__filter);
      return ok({ data: { attributes: { results: [{ groupings: { campaign_id: "K1" }, statistics: { recipients: 10, delivered: 10, opens_unique: 5, clicks_unique: 1, unsubscribe_uniques: 0 } }] } } });
    };
    const ts = [task({ route: "klaviyo", provider_ref: "K1", group_key: "klaviyo:a" }), task({ route: "klaviyo", provider_ref: "K2", group_key: "klaviyo:a" })];
    const h = harness(ts, { providerAccess: async () => ({ kind: "ok", call: k, sameCredential: true, cacheKey: "klaviyo:a" }) });
    await runEmailResultsPass(h.deps);
    expect(reports).toEqual(['contains-any(campaign_id,["K1","K2"])']);
    expect(h.done.find((d) => d.t.provider_ref === "K1")!.c).toMatchObject({ outcome: "done", result: { delivered: 10, opens: 5 } });
    expect(h.done.find((d) => d.t.provider_ref === "K2")!.c.outcome).toBe("retry");
  });

  it("Zavi's own sender: counts from the ledger; delivered and opens are '–' until a delivered event arrived; clicks are off", async () => {
    expect(bulkNumbers({ sent: 50, delivered: 0, opens: 3, machine_opens: 9, unsubscribes: 1, delivered_seen_at: null })).toEqual({
      recipients: 50, delivered: null, opens: null, machine_opens: null, clicks: null, clicks_off: true, bounces: null, unsubscribes: 1,
    });
    const h = harness([task({ route: "zavi_list", provider_ref: "send-1", account_ref: null, group_key: `zavi_list:${T}` })], {
      bulkCounts: async () => ({ sent: 50, delivered: 48, opens: 20, machine_opens: 9, unsubscribes: 1, delivered_seen_at: "2026-10-12T16:00:00Z" }),
    });
    await runEmailResultsPass(h.deps);
    expect(h.done[0].c).toEqual({ outcome: "done", result: { recipients: 50, delivered: 48, opens: 20, machine_opens: 9, clicks: null, clicks_off: true, bounces: null, unsubscribes: 1 } });
  });
});

describe("email results pass: GA check-backs", () => {
  const ga = (over: Partial<ClaimedTask> = {}) => task({ source: "ga", group_key: `ga:${T}`, ...over });
  const creds = { property_id: "P1", auth: { kind: "native" } } as never;

  it("GA not connected: waits a day, visitors unknown", async () => {
    const h = harness([ga()]);
    await runEmailResultsPass(h.deps);
    expect(h.done[0].c).toMatchObject({ outcome: "waiting", result: { visitors: null, ga_status: "not_connected" } });
    expect(h.done[0].c.next_due!.getTime()).toBe(NOW.getTime() + 86_400_000);
  });

  it("visitors from the property, time zone probed once and frozen with the property", async () => {
    const bodies: unknown[] = [];
    const h = harness([ga(), ga({ campaign_slug: "other-20261012-abcdefghij" })], {
      gaCreds: async () => creds,
      gaReport: async (_c, body) => {
        bodies.push(body);
        return body.dimensionFilter ? { rows: [{ metricValues: [{ value: "7" }] }] } : { metadata: { timeZone: "America/Chicago" } };
      },
    });
    await runEmailResultsPass(h.deps);
    expect(bodies.filter((b) => !(b as { dimensionFilter?: unknown }).dimensionFilter)).toHaveLength(1);
    expect(h.done.map((d) => d.c)).toEqual([
      { outcome: "done", result: { visitors: 7, ga_status: "ok" }, ga: { property_id: "P1", timezone: "America/Chicago" } },
      { outcome: "done", result: { visitors: 7, ga_status: "ok" }, ga: { property_id: "P1", timezone: "America/Chicago" } },
    ]);
  });

  it("another property than the frozen one is never read: the SQL marks it", async () => {
    let reads = 0;
    const h = harness([ga({ ga_property_id: "OLD" })], {
      gaCreds: async () => creds,
      gaReport: async () => {
        reads++;
        return {};
      },
    });
    await runEmailResultsPass(h.deps);
    expect(reads).toBe(0);
    expect(h.done[0].c).toEqual({ outcome: "done", result: {}, ga: { property_id: "P1", timezone: null } });
  });

  it("a GA 429 waits without spending an attempt", async () => {
    const h = harness([ga({ ga_timezone: "UTC" })], {
      gaCreds: async () => creds,
      gaReport: async () => {
        throw new Error("GA4 runReport returned 429: quota");
      },
    });
    await runEmailResultsPass(h.deps);
    expect(h.done[0].c.outcome).toBe("rate_limited");
  });
});

describe("email results pass: housekeeping", () => {
  it("repairs missed rows, logs the backlog and alerts each newly stuck task once", async () => {
    const alerts: unknown[] = [];
    const started: unknown[] = [];
    const h = harness([], {
      missing: async () => [{ tenant_id: T, rail: "decisions", card_id: "d1", sent: 5 }],
      start: async (i) => {
        started.push(i);
        return { started: true };
      },
      backlog: async () => ({ due: 4, oldest_due_at: "2026-10-20T11:00:00Z", newly_stuck: [{ tenant_id: T, source: "ga", stage: "d7", last_error: null }] }),
      alertStuck: async (s) => {
        alerts.push(s);
      },
    });
    const report = await runEmailResultsPass(h.deps);
    expect(started).toEqual([{ tenant_id: T, rail: "decisions", card_id: "d1", sent: 5 }]);
    expect(report).toMatchObject({ repaired: 1, backlog_due: 4, oldest_due_age_min: 60, stuck_alerted: 1 });
    expect(alerts).toHaveLength(1);
    expect(h.logs).toContain("email_results.repaired");
    expect(h.logs).toContain("email_results.pass");
  });

  it("past the time budget, groups not started are handed back for the next pass", async () => {
    let t = NOW.getTime();
    const h = harness([task({ group_key: "a" }), task({ group_key: "b" }), task({ group_key: "c" }), task({ group_key: "d" }), task({ group_key: "e" })], {
      now: () => new Date((t += 60_000 * 2)),
    });
    await runEmailResultsPass(h.deps);
    expect(h.done.some((d) => d.c.outcome === "rate_limited")).toBe(true);
  });
});

describe("email results pass: inside the lease", () => {
  it("a group runs at most 15 check-backs; the rest go back at once, no attempt spent", async () => {
    const ts = Array.from({ length: 18 }, () => task({ group_key: "one-account" }));
    const h = harness(ts);
    await runEmailResultsPass(h.deps);
    expect(h.done.filter((d) => d.c.outcome === "done")).toHaveLength(15);
    const back = h.done.filter((d) => d.c.outcome === "rate_limited");
    expect(back).toHaveLength(3);
    expect(back.every((d) => d.c.next_due!.getTime() === NOW.getTime())).toBe(true);
  });

  it("past the pass budget, a running group hands back the check-backs it has not started", async () => {
    let t = NOW.getTime();
    const slow: ProviderCall = async () => {
      t += 120_000;
      return ok({ data: { emails_sent: 1 } });
    };
    const h = harness(Array.from({ length: 6 }, () => task({ group_key: "slow" })), {
      providerAccess: async () => ({ kind: "ok", call: slow, sameCredential: true, cacheKey: "k" }),
      now: () => new Date(t),
    });
    await runEmailResultsPass(h.deps);
    const done = h.done.filter((d) => d.c.outcome === "done").length;
    const back = h.done.filter((d) => d.c.outcome === "rate_limited").length;
    expect(done + back).toBe(6);
    expect(done).toBeLessThan(6);
    expect(back).toBeGreaterThan(0);
  });

  it("the repair sweep stops starting rows after its budget, so due check-backs still run", async () => {
    let t = NOW.getTime();
    const started: string[] = [];
    const h = harness([task()], {
      missing: async () => Array.from({ length: 10 }, (_, i) => ({ tenant_id: T, rail: "decisions" as const, card_id: `d${i}`, sent: 1 })),
      start: async (i) => {
        started.push(i.card_id);
        t += 30_000;
        return { started: true };
      },
      now: () => new Date(t),
    });
    await runEmailResultsPass(h.deps);
    expect(started.length).toBeLessThan(10);
    expect(h.done[0].c.outcome).toBe("done");
  });
});

describe("starting a results row", () => {
  const content = { subject: "Spring update", preview_text: "", title: "Hello", paragraphs: ["Hi"], button: { label: "Read", url: "https://brightloop.test/a" } };
  const variant = { content, html: "<p>x</p>", text: "x", render_sha: shaOf("r1", "<p>x</p>", "x") };
  const snapshot = {
    logo_url: null, brand_color: "#112233", button_color: "#112233", font_key: "system", sign_off: "Thanks", postal_address: "1 Main St",
    show_cards: false, company_name: "Brightloop", own_host: "brightloop.test", campaign_slug: "spring-update-20261012-abcdefghij",
  };
  const toolBody = {
    tool: "mailchimp",
    credential: { kind: "composio", connected_account_id: "acct-1", auth_config_id: "ac" },
    audience_id: "list-1",
    audience_name: "Customers",
    audience_count: 120,
    approved_count: 118,
    variants: [variant],
    template_snapshot: snapshot,
    renderer_version: "r1",
    chosen_variant: 1,
    from_name: "Brightloop",
    from_email: "hello@brightloop.test",
    reply_to: null,
  };

  it("a tool send needs the campaign id the executor stored before the send", () => {
    const card = { class: "email_campaign.create_and_send", body: toolBody, progress: null, ended_at: "2026-10-12T15:00:00Z" };
    expect(rowFromCard({ tenant_id: T, rail: "decisions", card_id: "c1" }, card, null, null, NOW)).toEqual({ ok: false, reason: "no_campaign_id" });
    const r = rowFromCard({ tenant_id: T, rail: "decisions", card_id: "c1", sent: 117 }, card, "camp-9", null, NOW);
    expect(r).toMatchObject({
      ok: true,
      row: { route: "mailchimp", provider_ref: "camp-9", list_id: "list-1", list_name: "Customers", sent_count: 117, campaign_slug: "spring-update-20261012-abcdefghij", provider_group: "mailchimp:acct-1:ac" },
    });
    const viaProgress = rowFromCard({ tenant_id: T, rail: "channel_actions", card_id: "c1" }, { ...card, progress: { campaign_id: "camp-7", stage: "sent" } }, null, null, NOW);
    expect(viaProgress).toMatchObject({ ok: true, row: { provider_ref: "camp-7", sent_count: 118 } });
  });

  it("a Zavi-list send reads the ledger; nobody emailed is not a result", () => {
    const body = { list_id: "11111111-1111-4111-8111-111111111111", list_version_id: "22222222-2222-4222-8222-222222222222", list_name: "Members", from_address: "news@northwind.test", variants: [variant], template_snapshot: { ...snapshot, campaign_slug: "members-20261012-abcdefghij" }, renderer_version: "r1", chosen_variant: 1 };
    const card = { class: "bulk_outbound.send", body, progress: null, ended_at: null };
    const bulk = { id: "send-1", status: "done", sent: 40, total: 42, created_at: "2026-10-12T15:00:00Z", finished_at: "2026-10-13T15:00:00Z" };
    const r = rowFromCard({ tenant_id: T, rail: "decisions", card_id: "d1" }, card, null, bulk, NOW);
    expect(r).toMatchObject({ ok: true, row: { route: "zavi_list", provider_ref: "send-1", sent_count: 40, total_count: null, started_at: bulk.created_at, finished_at: bulk.finished_at, campaign_slug: "members-20261012-abcdefghij" } });
    expect(rowFromCard({ tenant_id: T, rail: "decisions", card_id: "d1" }, card, null, { ...bulk, sent: 0 }, NOW)).toMatchObject({ ok: false });
  });

  it("the subject is the version that was sent, not version A (both routes)", () => {
    const b = { ...variant, content: { ...content, subject: "Spring update B" } };
    const tool = { class: "email_campaign.create_and_send", body: { ...toolBody, variants: [variant, b], chosen_variant: 2 }, progress: { campaign_id: "camp-2", stage: "sent" }, ended_at: "2026-10-12T15:00:00Z" };
    expect(rowFromCard({ tenant_id: T, rail: "channel_actions", card_id: "c2" }, tool, null, null, NOW)).toMatchObject({ ok: true, row: { subject: "Spring update B" } });
    const list = {
      class: "bulk_outbound.send",
      body: { list_id: "11111111-1111-4111-8111-111111111111", list_version_id: "22222222-2222-4222-8222-222222222222", list_name: "Members", from_address: "news@northwind.test", variants: [variant, b], template_snapshot: snapshot, renderer_version: "r1", chosen_variant: 2 },
      progress: null,
      ended_at: null,
    };
    const bulk = { id: "send-2", status: "done", sent: 40, total: 42, created_at: "2026-10-12T15:00:00Z", finished_at: "2026-10-13T15:00:00Z" };
    expect(rowFromCard({ tenant_id: T, rail: "decisions", card_id: "d2" }, list, null, bulk, NOW)).toMatchObject({ ok: true, row: { subject: "Spring update B" } });
  });

  it("groups: one Composio account, one SendGrid key, one workspace's Zavi lists", () => {
    expect(providerGroup("klaviyo", T, { kind: "composio", connected_account_id: "acc" })).toBe("klaviyo:acc");
    expect(providerGroup("klaviyo", T, { kind: "composio", connected_account_id: "acc", auth_config_id: "cfg" })).toBe("klaviyo:acc:cfg");
    expect(legacyProviderGroup("klaviyo:acc:cfg")).toBe("klaviyo:acc");
    expect(legacyProviderGroup("sendgrid:abc")).toBeNull();
    expect(providerGroup("sendgrid", T, { kind: "sendgrid_key", key_digest: "f".repeat(64) })).toBe(`sendgrid:${"f".repeat(32)}`);
    expect(providerGroup("zavi_list", T, null)).toBe(`zavi_list:${T}`);
  });

  it("freezes GA's property and picks the win line from it; a shared tag never gets a visitors win line", async () => {
    const card = { class: "email_campaign.create_and_send", body: toolBody, progress: { campaign_id: "camp-1", stage: "sent" }, ended_at: "2026-10-12T15:00:00Z" };
    const seen: Array<Record<string, unknown>> = [];
    const deps = (taken: boolean): Partial<StartDeps> => ({
      readCard: async () => card,
      readRef: async () => null,
      readBulk: async () => null,
      gaProperty: async () => "P1",
      slugTaken: async () => taken,
      winLine: async (_t, a) => ({ metric: a.tagged && a.gaConnected ? "visitors" : "clicks", threshold: null, basis: "first_sends", n_past: 0 }),
      rpc: async (_t, row) => {
        seen.push(row as unknown as Record<string, unknown>);
        return { ok: true, created: true };
      },
      now: () => NOW,
    });
    expect(await startEmailSendResult({ tenant_id: T, rail: "channel_actions", card_id: "c1", sent: 118 }, deps(false))).toEqual({ started: true });
    expect(seen[0]).toMatchObject({ ga_property_id: "P1", win_line: { metric: "visitors" } });
    await startEmailSendResult({ tenant_id: T, rail: "channel_actions", card_id: "c1", sent: 118 }, deps(true));
    expect(seen[1]).toMatchObject({ win_line: { metric: "clicks" } });
  });

  it("the SQL's refusal is reported, not thrown", async () => {
    const out = await startEmailSendResult(
      { tenant_id: T, rail: "channel_actions", card_id: "c1" },
      {
        readCard: async () => ({ class: "email_campaign.create_and_send", body: toolBody, progress: { campaign_id: "camp-1", stage: "sent" }, ended_at: null }),
        gaProperty: async () => null,
        slugTaken: async () => false,
        winLine: async () => ({ metric: "clicks", threshold: null, basis: "first_sends", n_past: 0 }),
        rpc: async () => ({ ok: false, code: "not_final" }),
        now: () => NOW,
      },
    );
    expect(out).toEqual({ started: false, reason: "not_final" });
  });

  it("an EmailToolError keeps its status for the worker", () => {
    expect(new EmailToolError("x", false, 429, 5).retry_after_s).toBe(5);
  });
});

describe("email results pass: two workspaces on the same tool account", () => {
  const U = "00000000-0000-4000-8000-000000000002";
  const sealed = { kind: "sendgrid_key", key_digest: "d".repeat(64) };
  const sg = (tenant: string, ref: string) => task({ tenant_id: tenant, route: "sendgrid", provider_ref: ref, group_key: `sendgrid:${"d".repeat(32)}`, account_ref: sealed, campaign_title: null });

  it("a workspace that disconnected reads disconnected even when another workspace on the same key is read first", async () => {
    const asked: string[] = [];
    const call: ProviderCall = async () => ok({});
    const h = harness([sg(T, "s1"), sg(U, "s2")], {
      providerAccess: async (tenant) => {
        asked.push(tenant);
        return tenant === T ? { kind: "ok", call, sameCredential: true, cacheKey: "sendgrid:d" } : { kind: "none" };
      },
    });
    await runEmailResultsPass(h.deps);
    expect(asked.sort()).toEqual([T, U].sort());
    expect(h.done.find((d) => d.t.tenant_id === U)!.c).toMatchObject({ outcome: "disconnected" });
    expect(h.done.find((d) => d.t.tenant_id === T)!.c.outcome).not.toBe("disconnected");
  });

  it("the other order: the disconnected workspace first never blocks the connected one", async () => {
    const call: ProviderCall = async () => ok({});
    const h = harness([sg(U, "s2"), sg(T, "s1")], {
      providerAccess: async (tenant) => (tenant === T ? { kind: "ok", call, sameCredential: true, cacheKey: "sendgrid:d" } : { kind: "none" }),
    });
    await runEmailResultsPass(h.deps);
    expect(h.done.find((d) => d.t.tenant_id === U)!.c).toMatchObject({ outcome: "disconnected" });
    expect(h.done.find((d) => d.t.tenant_id === T)!.c.outcome).not.toBe("disconnected");
  });
});
