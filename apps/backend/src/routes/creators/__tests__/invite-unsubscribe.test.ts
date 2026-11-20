
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("@/services/creators/creator-invites", () => ({ unsubscribeInvite: vi.fn() }));

import { makeCreatorInviteUnsubscribeHandlers } from "../invite-unsubscribe";

const TOKEN = "22222222-2222-4222-8222-222222222222";

function res() {
  const r = { statusCode: 200, headers: {} as Record<string, string>, text: "" } as Record<string, unknown> & {
    statusCode: number;
    headers: Record<string, string>;
    text: string;
  };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.set = (k: string, v: string) => ((r.headers[k] = v), r);
  r.type = () => r;
  r.send = (t: string) => ((r.text = t), r);
  return r as unknown as Response & { statusCode: number; headers: Record<string, string>; text: string };
}
const req = (query: Record<string, string>, body: Record<string, string> = {}) =>
  ({ query, body }) as unknown as Request;

describe("creator invite unsubscribe", () => {
  it("GET only shows a confirm form and writes nothing", async () => {
    const unsubscribe = vi.fn();
    const r = res();
    await makeCreatorInviteUnsubscribeHandlers({ unsubscribe }).get(req({ t: TOKEN }), r);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(200);
    expect(r.text).toContain('method="post"');
    expect(r.text).toContain(`value="${TOKEN}"`);
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("GET escapes the token into the form", async () => {
    const r = res();
    await makeCreatorInviteUnsubscribeHandlers({ unsubscribe: vi.fn() }).get(req({ t: '"><script>x</script>' }), r);
    expect(r.text).not.toContain("<script>x");
  });

  it("the form POST writes the opt-out as a link click", async () => {
    const unsubscribe = vi.fn(async () => {});
    const r = res();
    await makeCreatorInviteUnsubscribeHandlers({ unsubscribe }).post(req({}, { t: TOKEN }), r);
    expect(unsubscribe).toHaveBeenCalledWith(TOKEN, "link");
    expect(r.statusCode).toBe(200);
    expect(r.text).toContain("unsubscribed");
  });

  it("the RFC 8058 one-click POST writes it as one_click", async () => {
    const unsubscribe = vi.fn(async () => {});
    const r = res();
    await makeCreatorInviteUnsubscribeHandlers({ unsubscribe }).post(req({ t: TOKEN }, { "List-Unsubscribe": "One-Click" }), r);
    expect(unsubscribe).toHaveBeenCalledWith(TOKEN, "one_click");
  });

  it("a cut-off link says so instead of claiming an opt-out", async () => {
    const unsubscribe = vi.fn();
    const r = res();
    await makeCreatorInviteUnsubscribeHandlers({ unsubscribe }).post(req({ t: "2222-cut" }), r);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(400);
    expect(r.text).toContain("incomplete");
  });

  it("a write failure is a 500, so the person can try again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = res();
    await makeCreatorInviteUnsubscribeHandlers({
      unsubscribe: vi.fn(async () => {
        throw new Error("db down");
      }),
    }).post(req({ t: TOKEN }), r);
    expect(r.statusCode).toBe(500);
    warn.mockRestore();
  });
});
