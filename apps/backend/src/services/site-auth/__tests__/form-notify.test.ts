import { describe, expect, it } from "vitest";
import {
  DIGEST_OVER,
  drainFormNotifications,
  FORM_NOTIFY_BACKLOG_ALERT_S,
  formNotifyUnsubscribeUrl,
  mintOptOutToken,
  readOptOutToken,
  recipientTag,
  renderFormDigest,
  type FormNotifyDeps,
  type FormNotifyTarget,
} from "../form-notify";
import { createSiteNoticeMailer, NOTICE_SITE_MAX_PER_HOUR, type NoticeSendFn } from "../mailer";
import type { FormNoticeRow } from "../types";
import { ALIAS_KEY, SITE_A, SITE_B, world } from "./fakes";

const REC = "dddddddd-0000-4000-8000-000000000001";

function notice(siteId: string, n: number, data: Record<string, unknown> = { name: `Visitor ${n}`, body: "Hello" }): FormNoticeRow & { leaseUntil: null; attempts: number } {
  return {
    id: String(n), leaseToken: "", siteId, collection: "submissions", recordId: REC.replace(/1$/, String(n % 10)),
    data, fields: {}, createdAt: "2026-10-02T10:00:00.000Z", leaseUntil: null, attempts: 0,
  };
}

function setup(over: { target?: Partial<FormNotifyTarget> | null; send?: NoticeSendFn; tenantOwner?: string | null } = {}) {
  const w = world();
  const sent: Array<{ to: string; subject: string; html: string; text: string; headers?: Record<string, string>; fromName: string }> = [];
  const logs: string[] = [];
  const alerts: Array<{ msg: string; code: string }> = [];
  const deps: FormNotifyDeps = {
    directory: w.directory,
    target: async () =>
      over.target === null
        ? null
        : { tenantId: "t1", ownerEmail: "Owner@Example.com", hostname: "a-shop.zaviagent.com", name: "A Shop", status: "live", muted: false, version: 0, ...over.target },
    tenantOwnerEmail: async () => over.tenantOwner ?? null,
    mailer: createSiteNoticeMailer(
      over.send ??
        (async (to, subject, html, text, from, opts) => {
          sent.push({ to, subject, html, text, headers: opts?.headers, fromName: from.name });
        }),
    ),
    unsubscribeUrl: (s, r, v) => formNotifyUnsubscribeUrl("https://api.zaviagent.com", ALIAS_KEY, { siteId: s, recipient: r, version: v, nowS: w.now() / 1000 }),
    alert: async (msg, code) => {
      alerts.push({ msg, code });
    },
    now: w.now,
    log: (l) => logs.push(l),
  };
  return { w, deps, sent, logs, alerts };
}

describe("drainFormNotifications", () => {
  it("mails the owner one email per submission, then clears the rows", async () => {
    const { w, deps, sent } = setup();
    w.store.notices.push(notice(SITE_A, 1), notice(SITE_A, 2));
    const t = await drainFormNotifications(deps, w.shard);
    expect(t).toMatchObject({ sent: 2, records: 2, dropped: 0, failed: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[0].to).toBe("owner@example.com");
    expect(sent[0].subject).toBe("New form submission on A Shop");
    expect(sent[0].text).toContain("Visitor 1");
    expect(sent[1].text).toContain("Visitor 2");
    expect(sent[0].text).toContain("See all in your admin page: https://a-shop.zaviagent.com/admin?from=zavi\n");
    expect(sent[0].html).toContain('href="https://a-shop.zaviagent.com/admin?from=zavi"');
    expect(sent[0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const link = /t=([^>]+)>/.exec(sent[0].headers?.["List-Unsubscribe"] ?? "")?.[1] ?? "";
    expect(readOptOutToken(ALIAS_KEY, link, w.now() / 1000)).toMatchObject({ s: SITE_A, a: "mute", v: 0, r: recipientTag(ALIAS_KEY, "owner@example.com") });
    expect(w.store.notices).toEqual([]);
  });

  it("a burst (more than DIGEST_OVER in one drain) is ONE summary mail, not a flood", async () => {
    const { w, deps, sent } = setup();
    for (let i = 1; i <= DIGEST_OVER + 2; i++) w.store.notices.push(notice(SITE_A, i));
    const t = await drainFormNotifications(deps, w.shard);
    expect(t).toMatchObject({ sent: 1, records: DIGEST_OVER + 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(`${DIGEST_OVER + 2} new form submissions on A Shop`);
    expect(w.store.notices).toEqual([]);
  });

  it("falls back to the workspace owner when the site has no owner email", async () => {
    const { w, deps, sent } = setup({ target: { ownerEmail: null }, tenantOwner: "boss@example.com" });
    w.store.notices.push(notice(SITE_A, 1));
    await drainFormNotifications(deps, w.shard);
    expect(sent[0].to).toBe("boss@example.com");
  });

  for (const [why, target, reason] of [
    ["an opted-out owner", { muted: true }, "owner_opted_out"],
  ] as const) {
    it(`drops (never mails) ${why}`, async () => {
      const { w, deps, sent, logs } = setup({ target });
      w.store.notices.push(notice(SITE_A, 1));
      const t = await drainFormNotifications(deps, w.shard);
      expect(t).toMatchObject({ sent: 0, dropped: 1 });
      expect(sent).toEqual([]);
      expect(w.store.notices).toEqual([]);
      expect(logs.join("\n")).toContain(reason);
    });
  }

  it("drops a notice whose site Zavi does not know, or that lives on another shard (never mails across sites)", async () => {
    const other = setup();
    other.w.sites[SITE_B] = { ...other.w.sites[SITE_B], shardId: "shard-2" };
    other.w.store.notices.push(notice(SITE_B, 1));
    expect(await drainFormNotifications(other.deps, other.w.shard)).toMatchObject({ sent: 0, dropped: 1 });
    expect(other.sent).toEqual([]);
    const gone = setup({ target: null });
    gone.w.store.notices.push(notice(SITE_A, 1));
    expect(await drainFormNotifications(gone.deps, gone.w.shard)).toMatchObject({ sent: 0, dropped: 1 });
    expect(gone.sent).toEqual([]);
  });

  for (const [why, over, reason] of [
    ["the directory cannot resolve the site (missing or a failed read look the same)", { unresolved: true }, "site_unresolved"],
    ["no owner address could be read (the fallback swallows read failures)", { target: { ownerEmail: null } }, "no_owner_email"],
  ] as const) {
    it(`keeps the rows for a retry when ${why}`, async () => {
      const { w, deps, sent, logs } = setup("target" in over ? { target: over.target } : {});
      if ("unresolved" in over) delete (w.sites as Record<string, unknown>)[SITE_A];
      w.store.notices.push(notice(SITE_A, 1));
      expect(await drainFormNotifications(deps, w.shard)).toMatchObject({ sent: 0, dropped: 0, failed: 1 });
      expect(sent).toEqual([]);
      expect(w.store.notices).toHaveLength(1);
      expect(logs.join("\n")).toContain(reason);
    });
  }

  it("a drain whose lease expired and was re-claimed cannot complete the row (no lost or doubled bookkeeping)", async () => {
    const { w, deps } = setup();
    w.store.notices.push(notice(SITE_A, 1));
    const [first] = await w.store.formNotifyClaim(10, 5);
    w.advance(6000);
    const [second] = await w.store.formNotifyClaim(10, 60);
    expect(await w.store.formNotifyDone([{ id: first.id, leaseToken: first.leaseToken }])).toBe(0);
    expect(w.store.notices).toHaveLength(1);
    expect(await w.store.formNotifyDone([{ id: second.id, leaseToken: second.leaseToken }])).toBe(1);
    void deps;
  });

  it("over the per-site mail budget: deferred, not lost, and no attempt spent", async () => {
    const { w, deps, sent } = setup();
    for (let i = 0; i < NOTICE_SITE_MAX_PER_HOUR; i++) await w.store.rateTake(`notice:site:${SITE_A}`, 3600, NOTICE_SITE_MAX_PER_HOUR);
    w.store.notices.push(notice(SITE_A, 1));
    const t = await drainFormNotifications(deps, w.shard);
    expect(t).toMatchObject({ sent: 0, deferred: 1 });
    expect(sent).toEqual([]);
    expect(w.store.notices).toHaveLength(1);
    expect(w.store.notices[0].attempts).toBe(0);
    expect(w.store.notices[0].leaseUntil).toBeGreaterThan(Date.now() - 1e12);
  });

  it("a send failure keeps the rows (lease expiry retries) and logs no recipient or value", async () => {
    const { w, deps, logs } = setup({
      send: async () => {
        throw new Error("sendgrid 503");
      },
    });
    w.store.notices.push(notice(SITE_A, 1, { name: "Secret Person", email: "visitor@private.test", body: "my phone 555" }));
    const t = await drainFormNotifications(deps, w.shard);
    expect(t).toMatchObject({ sent: 0, failed: 1 });
    expect(w.store.notices).toHaveLength(1);
    const all = logs.join("\n");
    expect(all).toContain("send_failed");
    expect(all).not.toMatch(/Secret Person|visitor@private|555|owner@example/i);
    w.advance(10 * 60 * 1000);
    const ok = setup();
    const t2 = await drainFormNotifications({ ...ok.deps, directory: w.directory }, w.shard);
    expect(t2.sent).toBe(1);
  });

  it("a publish-gate test site (not a Zavi sites row: no target) is dropped and never mailed, even when its shard resolves it", async () => {
    const { w, deps, sent, logs } = setup({ target: null });
    w.store.notices.push(notice(SITE_A, 1));
    expect(await drainFormNotifications(deps, w.shard)).toMatchObject({ sent: 0, dropped: 1 });
    expect(sent).toEqual([]);
    expect(w.store.notices).toEqual([]);
    expect(logs.join("\n")).toContain("not_a_zavi_site");
  });

  it("keeps claiming until a claim comes back EMPTY (a single busy site is not capped at one claim per run)", async () => {
    const { w, deps } = setup();
    for (let i = 1; i <= 45; i++) w.store.notices.push(notice(SITE_A, i));
    const claims: number[] = [];
    const orig = w.store.formNotifyClaim.bind(w.store);
    w.store.formNotifyClaim = async (_limit, lease) => {
      const rows = (await orig(20, lease));
      claims.push(rows.length);
      return rows;
    };
    const t = await drainFormNotifications(deps, w.shard);
    expect(claims).toEqual([20, 20, 5, 0]);
    expect(t.records).toBe(45);
    expect(w.store.notices).toEqual([]);
  });

  it("every purge of unsent notices is logged AND alerted, by reason", async () => {
    const { w, deps, logs, alerts } = setup();
    w.store.purgeResult = [{ reason: "expired", n: 2 }, { reason: "record_deleted", n: 3 }];
    const t = await drainFormNotifications(deps, w.shard);
    expect(t.lost).toBe(5);
    expect(alerts.map((a) => a.code)).toEqual(["sites.form_notify.expired", "sites.form_notify.record_deleted"]);
    expect(logs.join("\n")).toContain('"reason":"record_deleted"');
  });

  it("a stalled backlog alerts long before the 3-day purge", async () => {
    const { w, deps, alerts } = setup();
    w.store.notices.push({ ...notice(SITE_A, 1), createdAt: new Date(w.now() - (FORM_NOTIFY_BACKLOG_ALERT_S + 60) * 1000).toISOString(), leaseUntil: w.now() + 24 * 3600_000 } as never);
    await drainFormNotifications(deps, w.shard);
    expect(alerts.map((a) => a.code)).toContain("sites.form_notify.backlog");
    w.advance(5 * 60 * 1000);
    await drainFormNotifications(deps, w.shard);
    expect(alerts.filter((a) => a.code === "sites.form_notify.backlog")).toHaveLength(1);
    w.advance(60 * 60 * 1000);
    await drainFormNotifications(deps, w.shard);
    expect(alerts.filter((a) => a.code === "sites.form_notify.backlog")).toHaveLength(2);
  });

  it("a failure after one mail went out counts only the unsent ones, and the sent one is cleared", async () => {
    let calls = 0;
    const { w, deps } = setup({
      send: async () => {
        if (++calls === 2) throw new Error("sendgrid 503");
      },
    });
    w.store.notices.push(notice(SITE_A, 1), notice(SITE_A, 2), notice(SITE_A, 3));
    expect(await drainFormNotifications(deps, w.shard)).toMatchObject({ sent: 1, records: 1, failed: 2 });
    expect(w.store.notices.map((n) => n.id)).toEqual(["2", "3"]);
  });

  it("a site read failure keeps the rows for a retry", async () => {
    const { w, deps } = setup();
    deps.target = async () => {
      throw new Error("db down");
    };
    w.store.notices.push(notice(SITE_A, 1));
    expect((await drainFormNotifications(deps, w.shard)).failed).toBe(1);
    expect(w.store.notices).toHaveLength(1);
  });
});

describe("renderFormDigest", () => {
  it("escapes every submitted value and the site name (no HTML injection, no header injection)", () => {
    const m = renderFormDigest({
      siteName: "Evil <b>Co</b>\r\nBcc: x@y.z",
      hostname: "evil.zaviagent.com",
      notices: [{ ...notice(SITE_A, 1, { name: '<img src=x onerror="alert(1)">', body: "<script>x</script>" }) }],
      unsubscribeUrl: null,
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;img src=x");
    expect(m.html).not.toContain("<b>Co</b>");
  });

  it("leaves out a field admins cannot read, nested values, and empties", () => {
    const m = renderFormDigest({
      siteName: "Shop",
      hostname: "shop.zaviagent.com",
      notices: [{ ...notice(SITE_A, 1, { name: "Ann", internal: "hidden", tags: ["a", "b"], empty: "  ", nested: { x: 1 } }), fields: { internal: { read: ["role:staff"] } } }],
      unsubscribeUrl: null,
    });
    expect(m.text).toContain("Name: Ann");
    expect(m.text).toContain("Tags: a, b");
    expect(m.text).not.toContain("hidden");
    expect(m.text).not.toContain("Empty");
    expect(m.text).not.toContain("Nested");
  });

  it("shows at most 10 submissions and counts the rest", () => {
    const notices = Array.from({ length: 13 }, (_, i) => notice(SITE_A, i + 1));
    const m = renderFormDigest({ siteName: "Shop", hostname: "shop.zaviagent.com", notices, unsubscribeUrl: null });
    expect(m.subject).toBe("13 new form submissions on Shop");
    expect(m.text).toContain("And 3 more.");
    expect(m.text).not.toContain("Visitor 11");
  });
});

describe("opt-out token", () => {
  const NOW_S = Date.parse("2026-10-02T12:00:00Z") / 1000;
  const mint = (over: Partial<{ key: string; action: "mute" | "resume"; version: number }> = {}) =>
    mintOptOutToken(over.key ?? ALIAS_KEY, { siteId: SITE_A, recipient: "Owner@Example.com", action: over.action ?? "mute", version: over.version ?? 3, nowS: NOW_S });

  it("carries site, action, version and a keyed recipient tag (never the address)", () => {
    const t = mint();
    const c = readOptOutToken(ALIAS_KEY, t, NOW_S);
    expect(c).toMatchObject({ s: SITE_A, a: "mute", v: 3, r: recipientTag(ALIAS_KEY, "owner@example.com") });
    expect(Buffer.from(t.split(".")[0], "base64url").toString()).not.toMatch(/owner|example/i);
    expect(recipientTag(ALIAS_KEY, "other@example.com")).not.toBe(c?.r);
  });

  it("refuses another key, a tampered body, and an expired token", () => {
    const t = mint();
    expect(readOptOutToken("z".repeat(48), t, NOW_S)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), a: "resume" })).toString("base64url");
    expect(readOptOutToken(ALIAS_KEY, `${forged}.${sig}`, NOW_S)).toBeNull();
    expect(readOptOutToken(ALIAS_KEY, t, NOW_S + 181 * 86400)).toBeNull();
    expect(readOptOutToken(ALIAS_KEY, mint({ action: "resume" }), NOW_S + 31 * 86400)).toBeNull();
    expect(readOptOutToken(ALIAS_KEY, "", NOW_S)).toBeNull();
  });

  it("no https API base: no link (the mail still goes out)", () => {
    const i = { siteId: SITE_A, recipient: "o@example.com", version: 0, nowS: NOW_S };
    expect(formNotifyUnsubscribeUrl(undefined, ALIAS_KEY, i)).toBeNull();
    expect(formNotifyUnsubscribeUrl("http://localhost:3001", ALIAS_KEY, i)).toBeNull();
    expect(formNotifyUnsubscribeUrl("https://api.zaviagent.com/", ALIAS_KEY, i)).toMatch(/^https:\/\/api\.zaviagent\.com\/api\/public\/site-forms\/unsubscribe\?t=/);
  });
});
