import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { mintOptOutToken, type OptOutAction } from "@/services/site-auth/form-notify";
import { makeSiteFormUnsubscribeHandlers } from "../site-form-unsubscribe";

const KEY = "k".repeat(48);
const SITE = "aaaaaaaa-0000-4000-8000-00000000000a";
const NOW = Date.parse("2026-10-02T12:00:00Z");
const OWNER = "owner@example.com";

function res() {
  const r = { statusCode: 0, body: "", headers: {} as Record<string, string> };
  const api = {
    set(k: string, v: string) {
      r.headers[k] = v;
      return api;
    },
    status(c: number) {
      r.statusCode = c;
      return api;
    },
    type() {
      return api;
    },
    send(b: string) {
      r.body = b;
      return api;
    },
  };
  return { r, api: api as unknown as Response };
}

function world(over: { fail?: boolean; owner?: string; now?: number } = {}) {
  const state = { version: 0, muted: false, owner: over.owner ?? OWNER };
  const writes: Array<[boolean, number]> = [];
  const h = makeSiteFormUnsubscribeHandlers({
    key: () => KEY,
    now: () => over.now ?? NOW,
    current: async (s) => (s === SITE ? { version: state.version, recipient: state.owner } : null),
    setMuted: async (_s, m, v) => {
      if (over.fail) throw new Error("db down");
      if (v !== state.version) return null;
      state.version++;
      state.muted = m;
      writes.push([m, v]);
      return state.version;
    },
  });
  return { h, writes, state };
}

const tok = (action: OptOutAction, over: Partial<{ version: number; recipient: string; site: string; key: string; nowS: number }> = {}) =>
  mintOptOutToken(over.key ?? KEY, {
    siteId: over.site ?? SITE,
    recipient: over.recipient ?? OWNER,
    action,
    version: over.version ?? 0,
    nowS: over.nowS ?? NOW / 1000,
  });
const req = (query: Record<string, string>, body: Record<string, string> = {}) => ({ query, body }) as unknown as Request;
const resumeTokenIn = (html: string) => /name="t" value="([^"]+)"/.exec(html)?.[1] ?? "";

describe("site form opt-out", () => {
  it("GET only renders a confirm page: a link scanner changes nothing", async () => {
    const { h, writes } = world();
    const { r, api } = res();
    await h.get(req({ t: tok("mute") }), api);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('method="post"');
    expect(writes).toEqual([]);
  });

  it("POST (button or RFC 8058 one-click) mutes, then offers a SEPARATE resume link that works once", async () => {
    const w = world();
    const one = res();
    await w.h.post(req({ t: tok("mute") }, { "List-Unsubscribe": "One-Click" }), one.api);
    expect(one.r.statusCode).toBe(200);
    expect(w.writes).toEqual([[true, 0]]);
    const resume = resumeTokenIn(one.r.body);
    expect(resume).not.toBe(tok("mute"));
    const two = res();
    await w.h.post(req({}, { t: resume }), two.api);
    expect(two.r.statusCode).toBe(200);
    expect(w.state.muted).toBe(false);
    const again = res();
    await w.h.post(req({}, { t: resume }), again.api);
    expect(again.r.statusCode).toBe(400);
  });

  it("a replayed or older mute link does nothing once anything changed", async () => {
    const w = world();
    const t = tok("mute");
    await w.h.post(req({ t }), res().api);
    const { r, api } = res();
    await w.h.post(req({ t }), api);
    expect(r.statusCode).toBe(400);
    expect(w.writes).toHaveLength(1);
  });

  it("a mute link can never resume (actions are separate tokens)", async () => {
    const w = world();
    w.state.muted = true;
    await w.h.post(req({ t: tok("mute") }, { action: "resume" }), res().api);
    expect(w.state.muted).toBe(true);
  });

  it("a new owner (or a changed owner email) voids links mailed to the old address", async () => {
    const w = world({ owner: "new-owner@example.com" });
    const { r, api } = res();
    await w.h.post(req({ t: tok("mute") }), api);
    expect(r.statusCode).toBe(400);
    expect(w.writes).toEqual([]);
  });

  it("forged, other-key, cut-off, expired or unknown-site tokens write nothing", async () => {
    for (const t of [
      tok("mute", { key: "z".repeat(48) }),
      tok("mute").slice(0, 30),
      tok("mute", { nowS: NOW / 1000 - 200 * 86400 }),
      tok("mute", { site: "bbbbbbbb-0000-4000-8000-00000000000b" }),
      "garbage",
    ]) {
      const w = world();
      const { r, api } = res();
      await w.h.post(req({ t }), api);
      expect(r.statusCode).toBe(400);
      expect(w.writes).toEqual([]);
    }
  });

  it("a write failure says so (500), never claims an opt-out that did not happen", async () => {
    const { h } = world({ fail: true });
    const { r, api } = res();
    await h.post(req({ t: tok("mute") }), api);
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("are off");
  });
});
