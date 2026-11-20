
import { describe, expect, it } from "vitest";
import { deriveAlias } from "../alias";
import { createSiteMailer, RECIPIENT_MAX_PER_HOUR } from "../mailer";
import { handleSendEmailHook } from "../send-email-hook";
import { signStandardWebhook, verifyStandardWebhook } from "../webhook-signature";
import { ALIAS_KEY, SITE_A, SITE_B, world } from "./fakes";

const NOW = Date.parse("2026-10-01T12:00:00Z");

function setup() {
  const w = world({ now: () => NOW });
  const alias = deriveAlias(ALIAS_KEY, SITE_A, "alice@x.com");
  w.store.idents.push({ siteId: SITE_A, email: "alice@x.com", uid: "u-alice", alias, state: "active" });
  w.store.members.push({ siteId: SITE_A, uid: "u-alice", role: "user", status: "active", createdAt: NOW });
  const deps = { directory: w.directory, mailer: w.mailer, now: () => NOW };
  const payload = (over: Record<string, unknown> = {}, user: Record<string, unknown> = {}) =>
    JSON.stringify({
      user: { id: "u-alice", email: alias, ...user },
      email_data: {
        token: "123456",
        token_hash: "abcdef0123456789abcdef",
        redirect_to: "https://evil.example/steal",
        email_action_type: "magiclink",
        site_url: "https://evil.example",
        token_new: "",
        token_hash_new: "",
        ...over,
      },
    });
  const call = (body: string, opts: { secret?: string; ts?: number; shard?: string; tamper?: boolean } = {}) => {
    const ts = String(Math.floor((opts.ts ?? NOW) / 1000));
    const sig = signStandardWebhook(opts.secret ?? w.shard.hookSecret, "msg_1", ts, body);
    const sent = opts.tamper ? body.replace("alice", "mallory") : body;
    return handleSendEmailHook(deps, opts.shard ?? "shard-1", { id: "msg_1", timestamp: ts, signature: sig }, Buffer.from(sent));
  };
  return { w, alias, payload, call };
}

describe("Send Email Hook", () => {
  it("delivers to the real email with a link on the site's own hostname (payload redirect ignored)", async () => {
    const { w, call, payload } = setup();
    const r = await call(payload());
    expect(r).toEqual({ status: 200, body: {} });
    expect(w.mailer.sent).toHaveLength(1);
    const m = w.mailer.sent[0];
    expect(m).toMatchObject({ to: "alice@x.com", kind: "magic_link" });
    expect(m.link).toBe("https://a-shop.zaviagent.com/api/auth/callback?type=magiclink&token_hash=abcdef0123456789abcdef");
    expect(m.link).not.toContain("evil");
  });

  it("[malicious] bad, missing, stale, wrong-shard and tampered signatures are refused before parsing", async () => {
    const { w, call, payload } = setup();
    const other = "v1,whsec_" + Buffer.from("o".repeat(32)).toString("base64");
    expect((await call(payload(), { secret: other })).status).toBe(401);
    expect((await call(payload(), { ts: NOW - 6 * 60 * 1000 })).status).toBe(401);
    expect((await call(payload(), { tamper: true })).status).toBe(401);
    expect((await call(payload(), { shard: "shard-2" })).status).toBe(401);
    expect((await call(payload(), { shard: "../../etc" })).status).toBe(401);
    const missing = await handleSendEmailHook(
      { directory: w.directory, mailer: w.mailer, now: () => NOW }, "shard-1", {}, Buffer.from(payload()),
    );
    expect(missing.status).toBe(401);
    expect(w.mailer.sent).toHaveLength(0);
  });

  it("[malicious] refuses email_change in both payload shapes (Supabase's reversed token_hash fields) and reauthentication", async () => {
    const { w, call, payload } = setup();
    const shapes = [
      payload({ email_action_type: "email_change", token_hash: "newhash0123456789", token_hash_new: "curhash0123456789", token_new: "654321" }),
      payload({ email_action_type: "email_change", token_hash: "newhash0123456789", token_hash_new: "" }, { new_email: "attacker@evil.com" }),
      payload({ email_action_type: "reauthentication" }),
      payload({ email_action_type: "signup" }),
      payload({ email_action_type: "something_new" }),
    ];
    for (const p of shapes) expect((await call(p)).status).toBe(403);
    expect(w.mailer.sent).toHaveLength(0);
  });

  it("[malicious] refuses a non-alias recipient, an unknown alias, a user/alias mismatch and a deleting account", async () => {
    const { w, call, payload, alias } = setup();
    expect((await call(payload({}, { email: "victim@gmail.com" }))).status).toBe(403);
    expect((await call(payload({}, { email: deriveAlias(ALIAS_KEY, SITE_B, "ghost@x.com") }))).status).toBe(403);
    expect((await call(payload({}, { id: "u-someone-else" }))).status).toBe(403);
    w.store.idents[0].state = "deleting";
    expect((await call(payload({}, { email: alias }))).status).toBe(403);
    expect(w.mailer.sent).toHaveLength(0);
  });

  it("[malicious] a pending-change alias is resolvable but never used to send a hook mail", async () => {
    const { w, call, payload } = setup();
    const newAlias = deriveAlias(ALIAS_KEY, SITE_A, "new@x.com");
    await w.store.beginEmailChange(SITE_A, "u-alice", "new@x.com", newAlias, "sha", 3600);
    expect((await w.store.resolveAlias(newAlias)).map((r) => r.kind)).toEqual(["pending_change"]);
    expect((await w.store.resolveAlias(w.store.idents[0].alias)).map((r) => r.kind)).toEqual(["current"]);
    expect((await call(payload({}, { email: newAlias }))).status).toBe(403);
  });

  it("enforces the per-recipient limit (429 makes Supabase Auth fail the request)", async () => {
    const { w, alias } = setup();
    const sends: string[] = [];
    const mailer = createSiteMailer(async (to) => { sends.push(to); });
    const deps = { directory: w.directory, mailer, now: () => NOW };
    const statuses: number[] = [];
    for (let i = 0; i <= RECIPIENT_MAX_PER_HOUR; i++) {
      const body = JSON.stringify({ user: { id: "u-alice", email: alias }, email_data: { token_hash: "abcdef0123456789", email_action_type: "recovery" } });
      const ts = String(Math.floor(NOW / 1000));
      const r = await handleSendEmailHook(deps, "shard-1", { id: `m${i}`, timestamp: ts, signature: signStandardWebhook(w.shard.hookSecret, `m${i}`, ts, body) }, Buffer.from(body));
      statuses.push(r.status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(sends).toHaveLength(RECIPIENT_MAX_PER_HOUR);
  });
});

describe("site mailer", () => {
  it("escapes the founder-controlled site name and keeps the subject on one line", async () => {
    const { w } = setup();
    const out: Array<{ subject: string; html: string; from: { name: string } }> = [];
    const mailer = createSiteMailer(async (_to, subject, html, _text, from) => { out.push({ subject, html, from }); });
    const site = { ...w.sites[SITE_A], name: 'Evil <script>alert(1)</script>\r\nBcc: x@y.com' };
    await mailer.send(w.store, { site, to: "a@x.com", kind: "verify_signup", link: "https://a-shop.zaviagent.com/auth/confirm#x" });
    expect(out[0].html).not.toContain("<script>");
    expect(out[0].subject).not.toMatch(/[\r\n]/);
  });
});

describe("standard webhooks", () => {
  it("accepts any listed v1 signature and rejects malformed secrets", () => {
    const secret = "v1,whsec_" + Buffer.from("s".repeat(32)).toString("base64");
    const body = Buffer.from("{}");
    const sig = signStandardWebhook(secret, "id", "1759320000", body);
    expect(verifyStandardWebhook(secret, { id: "id", timestamp: "1759320000", signature: `v1,AAAA ${sig}` }, body, 1759320000_000)).toBe(true);
    expect(verifyStandardWebhook("v1,whsec_", { id: "id", timestamp: "1759320000", signature: sig }, body, 1759320000_000)).toBe(false);
    expect(verifyStandardWebhook(secret, { id: "id", timestamp: "1759320000", signature: sig.replace("v1,", "v2,") }, body, 1759320000_000)).toBe(false);
  });
});

describe("publish-gate test sites send no mail", () => {
  it("the mailer suppresses every message for a test site, before any limit is taken", async () => {
    const { w } = setup();
    const sends: string[] = [];
    const mailer = createSiteMailer(async (to) => { sends.push(to); });
    const site = { ...w.sites[SITE_A], test: true };
    for (const kind of ["verify_signup", "magiclink", "recovery", "invite"]) {
      expect(await mailer.send(w.store, { site, to: "a@x.com", kind, link: "https://x.example/" } as never)).toBe("suppressed");
    }
    expect(sends).toEqual([]);
  });

  it("a Send Email Hook call for a test site answers 200 and sends nothing", async () => {
    const { w, alias } = setup();
    const sends: string[] = [];
    const mailer = createSiteMailer(async (to) => { sends.push(to); });
    const directory = { ...w.directory, site: async (id: string) => { const s = await w.directory.site(id); return s ? { ...s, test: true } : null; } };
    const body = JSON.stringify({ user: { id: "u-alice", email: alias }, email_data: { token_hash: "abcdef0123456789", email_action_type: "recovery" } });
    const ts = String(Math.floor(NOW / 1000));
    const r = await handleSendEmailHook({ directory, mailer, now: () => NOW }, "shard-1", { id: "mt", timestamp: ts, signature: signStandardWebhook(w.shard.hookSecret, "mt", ts, body) }, Buffer.from(body));
    expect(r.status).toBe(200);
    expect(sends).toEqual([]);
  });
});
