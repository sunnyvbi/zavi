
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const q = vi.hoisted(() => ({ row: null as unknown, calls: [] as unknown[][] }));
vi.mock("@/services/tenant-client", () => {
  const b: Record<string, unknown> = {};
  for (const name of ["select", "eq"]) {
    b[name] = (...args: unknown[]) => (q.calls.push([name, ...args]), b);
  }
  b.maybeSingle = async () => ({ data: q.row, error: null });
  return { globalClient: () => ({ from: () => b }), creatorInviteRpc: vi.fn() };
});

import { makeCreatorInvitePrefillHandler } from "../invite-prefill";
import { invitePrefill } from "@/services/creators/creator-invites";

const TOKEN = "33333333-3333-4333-8333-333333333333";

function res() {
  const r = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown } as Record<string, unknown> & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.set = (k: string, v: string) => ((r.headers[k] = v), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r as unknown as Response & { statusCode: number; headers: Record<string, string>; body: any };
}
const req = (query: Record<string, string>) => ({ query }) as unknown as Request;

beforeEach(() => {
  q.row = null;
  q.calls.length = 0;
});

describe("invitePrefill", () => {
  it("looks the row up by the signup token and returns only name and email", async () => {
    q.row = { display_name: "Ivy Lane", email: "ivy@example.com", member_deleted_at: null };
    expect(await invitePrefill(TOKEN)).toEqual({ name: "Ivy Lane", email: "ivy@example.com" });
    expect(q.calls).toContainEqual(["eq", "signup_token", TOKEN]);
  });

  it("a bad token, a deleted creator or a row with no email gives nothing", async () => {
    expect(await invitePrefill("not-a-uuid")).toBeNull();
    expect(q.calls).toHaveLength(0);
    q.row = { display_name: "(deleted)", email: "ivy@example.com", member_deleted_at: "2026-10-01T00:00:00Z" };
    expect(await invitePrefill(TOKEN)).toBeNull();
    q.row = { display_name: "Ivy", email: null, member_deleted_at: null };
    expect(await invitePrefill(TOKEN)).toBeNull();
  });
});

describe("GET /api/creators/invite/prefill", () => {
  it("returns the name and email, never cached", async () => {
    const r = res();
    await makeCreatorInvitePrefillHandler({ prefill: async () => ({ name: "Ivy", email: "ivy@example.com" }) })(req({ t: TOKEN }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ name: "Ivy", email: "ivy@example.com" });
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("404s an unknown or missing token, and 503s a read failure", async () => {
    const r1 = res();
    await makeCreatorInvitePrefillHandler({ prefill: async () => null })(req({ t: TOKEN }), r1);
    expect(r1.statusCode).toBe(404);
    const prefill = vi.fn();
    const r2 = res();
    await makeCreatorInvitePrefillHandler({ prefill })(req({}), r2);
    expect(r2.statusCode).toBe(404);
    expect(prefill).not.toHaveBeenCalled();
    const r3 = res();
    await makeCreatorInvitePrefillHandler({ prefill: async () => Promise.reject(new Error("db down")) })(req({ t: TOKEN }), r3);
    expect(r3.statusCode).toBe(503);
  });
});
