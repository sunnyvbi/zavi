import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const s = vi.hoisted(() => ({
  role: "owner" as string | null,
  roleError: false,
  recorded: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "tenant-1", user_id: "user-1" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRole: async () => {
    if (s.roleError) throw new Error("tenant_users role read failed");
    return s.role;
  },
  requireTenantRole: async () => true,
}));
vi.mock("@/services/comms/bulk-outbound/lists", () => ({
  archiveList: vi.fn(),
  eraseContact: vi.fn(),
  importListVersion: vi.fn(),
  listContactsPage: vi.fn(),
  listSummaries: vi.fn(),
  recordListConsent: async (args: Record<string, unknown>) => {
    s.recorded.push(args);
    return { active_version_id: args.versionId };
  },
}));

import { postListConsent } from "../email-lists";

const LIST = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";

function call() {
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  } as unknown as Response;
  const req = { params: { id: LIST, vid: VER }, body: { confirmed: true } } as unknown as Request;
  return postListConsent(req, res).then(() => out);
}

beforeEach(() => {
  s.role = "owner";
  s.roleError = false;
  s.recorded.length = 0;
});

describe("POST /api/workspace/email-lists/:id/versions/:vid/consent", () => {
  it.each(["member", "viewer", null])("a %s cannot confirm consent, is told who can, and nothing is recorded", async (role) => {
    s.role = role;
    const out = await call();
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: { code: "not_authorized", message: "Only a workspace owner or admin can confirm consent for a list." } });
    expect(s.recorded).toHaveLength(0);
  });

  it("a role read that fails records nothing", async () => {
    s.roleError = true;
    const out = await call();
    expect(out.status).toBe(500);
    expect(s.recorded).toHaveLength(0);
  });

  it.each(["owner", "admin"])("an %s confirms it once", async (role) => {
    s.role = role;
    const out = await call();
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ active_version_id: VER });
    expect(s.recorded).toEqual([{ tenantId: "tenant-1", userId: "user-1", listId: LIST, versionId: VER }]);
  });
});
