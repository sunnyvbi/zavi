
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { Request, Response } from "express";
import sharp from "sharp";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  hasConsent: vi.fn(),
  capCheck: vi.fn(),
  recordRow: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth, authMiddleware: vi.fn() }));
vi.mock("@/services/extension/consent", () => ({
  hasCurrentExtensionConsent: m.hasConsent,
}));
vi.mock("@/services/agents/extension-spend-guard", () => ({
  checkExtensionScreenshotDailyCap: m.capCheck,
}));
vi.mock("@/services/extension/screenshots", () => ({
  recordExtensionScreenshot: m.recordRow,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    storage: { from: () => ({ upload: m.upload, remove: m.remove }) },
  }),
}));

import { postExtensionScreenshot } from "../screenshot";

function mkRes() {
  const r = {
    _status: 0,
    _body: undefined as unknown,
    status(c: number) {
      r._status = c;
      return r;
    },
    json(b: unknown) {
      r._body = b;
      return r;
    },
  };
  return r;
}

let png: Buffer;
beforeAll(async () => {
  png = await sharp({
    create: { width: 40, height: 40, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
});

function mkReq(): Request {
  return {
    file: { fieldname: "file", buffer: png, mimetype: "image/png", size: png.length },
  } as unknown as Request;
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.requireAuth.mockResolvedValue({ user_id: USER, tenant_id: TENANT, access_token: "x" });
  m.hasConsent.mockResolvedValue(true);
  m.capCheck.mockResolvedValue({ allowed: true, used: 3, cap: 50 });
  m.recordRow.mockResolvedValue(undefined);
  m.upload.mockResolvedValue({ data: { path: "p" }, error: null });
  m.remove.mockResolvedValue({ data: [], error: null });
});

describe("POST /api/extension/screenshot", () => {
  it("no consent → 403 consent_required, nothing stored, no ledger row", async () => {
    m.hasConsent.mockResolvedValue(false);
    const res = mkRes();
    await postExtensionScreenshot(mkReq(), res as unknown as Response);
    expect(res._status).toBe(403);
    expect((res._body as { error: { code: string } }).error.code).toBe("consent_required");
    expect(m.hasConsent).toHaveBeenCalledWith(TENANT, USER);
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.recordRow).not.toHaveBeenCalled();
    expect(m.capCheck).not.toHaveBeenCalled();
  });

  it("over the daily cap → 429 extension_daily_cap, nothing stored, no ledger row", async () => {
    m.capCheck.mockResolvedValue({ allowed: false, used: 50, cap: 50 });
    const res = mkRes();
    await postExtensionScreenshot(mkReq(), res as unknown as Response);
    expect(res._status).toBe(429);
    expect((res._body as { error: { code: string } }).error.code).toBe("extension_daily_cap");
    expect(m.capCheck).toHaveBeenCalledWith(TENANT);
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.recordRow).not.toHaveBeenCalled();
  });

  it("happy path → stores a JPEG at <tenant>/<uuid>.jpg, records the ledger row, returns image_path", async () => {
    const res = mkRes();
    await postExtensionScreenshot(mkReq(), res as unknown as Response);
    expect(res._status).toBe(200);
    const { image_path } = res._body as { image_path: string };
    expect(image_path).toMatch(new RegExp(`^${TENANT}/[0-9a-f-]{36}\\.jpg$`));
    expect(m.upload).toHaveBeenCalledTimes(1);
    const [path, buf, opts] = m.upload.mock.calls[0];
    expect(path).toBe(image_path);
    expect(opts.contentType).toBe("image/jpeg");
    expect([buf[0], buf[1], buf[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(m.recordRow).toHaveBeenCalledWith(TENANT, USER, image_path);
  });

  it("ledger write fails → 500 and the just-stored object is removed (no ownerless screenshot)", async () => {
    m.recordRow.mockRejectedValue(new Error("insert failed"));
    const res = mkRes();
    await postExtensionScreenshot(mkReq(), res as unknown as Response);
    expect(res._status).toBe(500);
    const stored = m.upload.mock.calls[0][0];
    expect(m.remove).toHaveBeenCalledWith([stored]);
  });

  it("missing file → 400 no_file after the gates, nothing stored", async () => {
    const res = mkRes();
    await postExtensionScreenshot({} as Request, res as unknown as Response);
    expect(res._status).toBe(400);
    expect(m.upload).not.toHaveBeenCalled();
  });
});
