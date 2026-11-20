
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logEventMock = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
const sgSendMock = vi.hoisted(() =>
  vi.fn(
    async (_to: string, _subject: string, _html: string, _text: string) => {},
  ),
);
const db = vi.hoisted(() => ({
  rows: new Map<string, { sent_at: string; confirmed_at: string | null }>(),
  claimError: false,
  deletes: [] as string[],
}));

vi.mock("../logEvent", () => ({ logEvent: logEventMock }));
vi.mock("@/email/sendAuthEmail", () => ({ sgSend: sgSendMock }));
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({
    from: (_table: string) => ({
      upsert: (row: { dedupe_key: string; sent_at: string }) => ({
        select: async () => {
          if (db.claimError)
            return { data: null, error: new Error("claim boom") };
          if (db.rows.has(row.dedupe_key)) return { data: [], error: null };
          db.rows.set(row.dedupe_key, {
            sent_at: row.sent_at,
            confirmed_at: null,
          });
          return { data: [{ dedupe_key: row.dedupe_key }], error: null };
        },
      }),
      select: () => ({
        eq: (_c: string, key: string) => ({
          maybeSingle: async () => ({
            data: db.rows.get(key) ?? null,
            error: null,
          }),
        }),
      }),
      update: (patch: { confirmed_at?: string; sent_at?: string }) => ({
        eq: async (_c: string, key: string) => {
          const cur = db.rows.get(key);
          if (cur) db.rows.set(key, { ...cur, ...patch });
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (_col: string, key: string) => {
          db.deletes.push(key);
          db.rows.delete(key);
          return { error: null };
        },
        lt: async () => ({ error: null }),
      }),
    }),
  }),
}));

import { alert, emailOpsAlert, __resetMemoryDedupForTests } from "../alert";

describe("alert() — opt-in email page", () => {
  beforeEach(() => {
    logEventMock.mockClear();
    sgSendMock.mockClear();
    sgSendMock.mockImplementation(async () => {});
    db.rows.clear();
    db.claimError = false;
    __resetMemoryDedupForTests();
    db.deletes = [];
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
    })) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
  });

  afterEach(() => {
    delete process.env.OPS_ALERT_EMAIL;
    vi.restoreAllMocks();
  });

  it("DEFAULT OFF: a caller with no `email` field sends no mail", async () => {
    await alert({ source: "run-failure-rate-canary", msg: "rate 80%" });
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(sgSendMock).not.toHaveBeenCalled();
  });

  it("opting in sends the mail to OPS_ALERT_EMAIL", async () => {
    await alert({
      source: "slack-delivery-failure-canary",
      msg: "GLOBAL Slack delivery FAILING",
      email: { dedupeKey: "slack_delivery:global:1" },
    });
    expect(sgSendMock).toHaveBeenCalledTimes(1);
    expect(sgSendMock.mock.calls[0][0]).toBe("ops@example.com");
    expect(String(sgSendMock.mock.calls[0][1])).toContain("[Zavi ALERT]");
  });

  it("sends even when the Slack webhook is DOWN (the whole point)", async () => {
    process.env.PRAXIS_ALERTS_SLACK_WEBHOOK = "https://hooks.slack.test/x";
    global.fetch = vi.fn(async () => {
      throw new Error("slack is on fire");
    }) as unknown as typeof fetch;

    await alert({
      source: "slack-delivery-canary",
      msg: "canary failed",
      email: { dedupeKey: "slack_canary:1" },
    });
    expect(sgSendMock).toHaveBeenCalledTimes(1);
  });

  it("DEDUP: the same incident key emails exactly ONCE", async () => {
    const input = {
      source: "slack-delivery-failure-canary",
      msg: "GLOBAL Slack delivery FAILING",
      email: { dedupeKey: "slack_delivery:global:42" },
    };
    await alert(input);
    await alert(input);
    await alert(input);
    expect(sgSendMock).toHaveBeenCalledTimes(1);
  });

  it("ATOMIC CLAIM: concurrent ticks racing the same key send exactly ONE email", async () => {
    const input = {
      source: "slack-delivery-failure-canary",
      msg: "GLOBAL",
      email: { dedupeKey: "slack_delivery:global:race" },
    };
    await Promise.all([alert(input), alert(input), alert(input)]);
    expect(sgSendMock).toHaveBeenCalledTimes(1);
  });

  it("a NEW incident key emails again (next bucket re-pages)", async () => {
    await alert({ source: "s", msg: "m", email: { dedupeKey: "k:1" } });
    await alert({ source: "s", msg: "m", email: { dedupeKey: "k:2" } });
    expect(sgSendMock).toHaveBeenCalledTimes(2);
  });

  it("RELEASE: a SendGrid failure drops the claim, so the next tick retries", async () => {
    sgSendMock.mockImplementationOnce(async () => {
      throw new Error("sendgrid 503");
    });

    await expect(
      alert({ source: "s", msg: "m", email: { dedupeKey: "k:same" } }),
    ).resolves.toBeUndefined();
    expect(db.deletes).toContain("k:same");
    expect(db.rows.has("k:same")).toBe(false);

    await alert({ source: "s", msg: "m", email: { dedupeKey: "k:same" } });
    expect(sgSendMock).toHaveBeenCalledTimes(2);
  });

  it("FAIL-OPEN: a claim-insert error still sends (a dup beats a miss)", async () => {
    db.claimError = true;
    await alert({ source: "s", msg: "m", email: { dedupeKey: "k:x" } });
    expect(sgSendMock).toHaveBeenCalledTimes(1);
  });

  it("REQUIRED: a failed send throws (after releasing the claim) so the caller can retry", async () => {
    sgSendMock.mockImplementationOnce(async () => {
      throw new Error("sendgrid 503");
    });
    await expect(
      alert({ source: "s", msg: "m", email: { dedupeKey: "k:req", required: true } }),
    ).rejects.toThrow("sendgrid 503");
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(db.rows.has("k:req")).toBe(false);
    await alert({ source: "s", msg: "m", email: { dedupeKey: "k:req", required: true } });
    await expect(
      alert({ source: "s", msg: "m", email: { dedupeKey: "k:req", required: true } }),
    ).resolves.toBeUndefined();
    expect(sgSendMock).toHaveBeenCalledTimes(2);
  });

  it("never throws even if the whole email path explodes", async () => {
    sgSendMock.mockImplementation(async () => {
      throw new Error("total meltdown");
    });
    await expect(
      alert({ source: "s", msg: "m", email: { dedupeKey: "k:boom" } }),
    ).resolves.toBeUndefined();
    expect(logEventMock).toHaveBeenCalledTimes(1);
  });

  it("LEASE TAKEOVER: a worker that crashed mid-send doesn't eat the page forever", async () => {
    db.rows.set("k:orphan", {
      sent_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      confirmed_at: null,
    });

    await alert({ source: "s", msg: "m", email: { dedupeKey: "k:orphan" } });
    expect(sgSendMock).toHaveBeenCalledTimes(1);
    expect(db.rows.get("k:orphan")?.confirmed_at).toBeTruthy();
  });

  it("a FRESH unconfirmed claim is left alone (another worker is mid-send)", async () => {
    db.rows.set("k:inflight", {
      sent_at: new Date(Date.now() - 5_000).toISOString(),
      confirmed_at: null,
    });
    await alert({ source: "s", msg: "m", email: { dedupeKey: "k:inflight" } });
    expect(sgSendMock).not.toHaveBeenCalled();
  });

  it("REQUIRED + a FRESH unconfirmed claim throws, so the caller retries instead of trusting it", async () => {
    db.rows.set("k:inflight-req", {
      sent_at: new Date(Date.now() - 5_000).toISOString(),
      confirmed_at: null,
    });
    await expect(
      alert({ source: "s", msg: "m", email: { dedupeKey: "k:inflight-req", required: true } }),
    ).rejects.toThrow(/in flight/);
    expect(sgSendMock).not.toHaveBeenCalled();
  });

  it("a CONFIRMED claim suppresses (we really did page)", async () => {
    db.rows.set("k:done", {
      sent_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      confirmed_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    await alert({ source: "s", msg: "m", email: { dedupeKey: "k:done" } });
    expect(sgSendMock).not.toHaveBeenCalled();
  });
});

describe("alert() email — DB-outage storm control", () => {
  beforeEach(() => {
    logEventMock.mockClear();
    sgSendMock.mockClear();
    sgSendMock.mockImplementation(async () => {});
    db.rows.clear();
    db.claimError = false;
    db.deletes = [];
    __resetMemoryDedupForTests();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
    })) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.PRAXIS_ALERTS_SLACK_WEBHOOK;
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
  });

  afterEach(() => {
    delete process.env.OPS_ALERT_EMAIL;
    vi.restoreAllMocks();
  });

  it("sends ONCE per key when the dedup ledger itself is unreachable", async () => {
    db.claimError = true;

    for (let i = 0; i < 12; i++) {
      await alert({
        source: "slack-delivery-failure-canary",
        code: "db_unreachable",
        msg: "DATABASE UNREACHABLE",
        email: { dedupeKey: "slack_delivery:db_unreachable:bucket-1" },
      });
    }

    expect(sgSendMock).toHaveBeenCalledTimes(1);
  });

  it("still pages for a DIFFERENT incident while the ledger is unreachable", async () => {
    db.claimError = true;
    await alert({ source: "s", msg: "m", email: { dedupeKey: "incident:A" } });
    await alert({ source: "s", msg: "m", email: { dedupeKey: "incident:A" } });
    await alert({ source: "s", msg: "m", email: { dedupeKey: "incident:B" } });
    expect(sgSendMock).toHaveBeenCalledTimes(2);
  });

  it("RELEASES the memory claim when the send fails, so the page is not eaten", async () => {
    db.claimError = true;

    sgSendMock.mockImplementationOnce(async () => {
      throw new Error("sendgrid 503");
    });

    await alert({ source: "s", msg: "m", email: { dedupeKey: "release:me" } });
    expect(sgSendMock).toHaveBeenCalledTimes(1);

    await alert({ source: "s", msg: "m", email: { dedupeKey: "release:me" } });
    expect(sgSendMock).toHaveBeenCalledTimes(2);

    await alert({ source: "s", msg: "m", email: { dedupeKey: "release:me" } });
    expect(sgSendMock).toHaveBeenCalledTimes(2);
  });

  it("does not dump a raw HTML error page into the mail body", async () => {
    db.claimError = true;
    const cloudflare522 =
      '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->' +
      "<head><title>supabase.co | 522: Connection timed out</title>" +
      '<meta charset="UTF-8" /></head><body>error</body></html>';

    await alert({
      source: "slack-delivery-failure-canary",
      msg: `delivery scan FAILED: ${cloudflare522}`,
      email: { dedupeKey: "html:body" },
    });

    const [, , html, text] = sgSendMock.mock.calls[0]!;
    expect(text).not.toContain("<!--[if lt IE 7]>");
    expect(text).not.toContain("<!DOCTYPE html");
    expect(text).toContain("HTTP 522");
    expect(text).toContain("522: Connection timed out");
    expect(html).not.toContain("[if lt IE 7]");
    expect(text.length).toBeLessThan(400);
  });
});

describe("emailOpsAlert() — the email half alone", () => {
  const input = { source: "first-plan-watch", code: "first_plan_missing", tenant_id: "t1", msg: "No first plan", email: { dedupeKey: "fpm:t1:d1", required: true } };
  beforeEach(() => {
    logEventMock.mockClear();
    sgSendMock.mockClear();
    sgSendMock.mockImplementation(async () => {});
    db.rows.clear();
    db.claimError = false;
    db.deletes = [];
    __resetMemoryDedupForTests();
    global.fetch = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
  });

  it("sends the mail with no log row and no Slack post, and reports true", async () => {
    expect(await emailOpsAlert(input)).toBe(true);
    expect(sgSendMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.rows.get("fpm:t1:d1")?.confirmed_at).toBeTruthy();
  });

  it("a confirmed key reports true without sending again", async () => {
    await emailOpsAlert(input);
    expect(await emailOpsAlert(input)).toBe(true);
    expect(sgSendMock).toHaveBeenCalledTimes(1);
  });

  it("a failed send reports false, releases the claim, never throws", async () => {
    sgSendMock.mockImplementation(async () => {
      throw new Error("sendgrid 500");
    });
    expect(await emailOpsAlert(input)).toBe(false);
    expect(db.rows.has("fpm:t1:d1")).toBe(false);
  });

  it("another worker mid-send (fresh unconfirmed claim) reports false so the caller retries", async () => {
    db.rows.set("fpm:t1:d1", { sent_at: new Date().toISOString(), confirmed_at: null });
    expect(await emailOpsAlert(input)).toBe(false);
    expect(sgSendMock).not.toHaveBeenCalled();
  });
});
