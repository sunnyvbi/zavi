
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const TENANT = "11111111-aaaa-aaaa-aaaa-111111111111";
const USER = "22222222-bbbb-bbbb-bbbb-222222222222";

let bearerValid = false;
vi.mock("@/services/tenants/disabled", () => ({
  readTenantDisabled: async () => false,
  TENANT_DISABLED_CODE: "tenant_disabled",
  TENANT_DISABLED_MESSAGE: "This workspace is disabled. Contact support@zaviagent.com.",
}));

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: async () =>
    bearerValid
      ? { user_id: USER, access_token: "tok", email: null, session_id: "sess" }
      : null,
}));
vi.mock("@/services/auth/tenant-cache", () => ({
  getCachedTenant: () => TENANT,
  setCachedTenant: () => {},
  invalidateCachedTenant: () => {},
}));
const roleRow = { data: { role: "member" }, error: null };
const roleChain = { select: () => roleChain, eq: () => roleChain, maybeSingle: async () => roleRow };
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({}),
  serverClientFromBearer: () => ({ from: () => roleChain }),
}));
vi.mock("@/services/extension/consent", () => ({ hasCurrentExtensionConsent: vi.fn(async () => true) }));
vi.mock("@/services/agents/extension-spend-guard", () => ({
  checkExtensionScreenshotDailyCap: vi.fn(async () => ({ allowed: true, used: 0, cap: 50 })),
}));
vi.mock("@/services/extension/screenshots", () => ({ recordExtensionScreenshot: vi.fn() }));
vi.mock("@/services/tenants/session-tenant", () => ({
  getSessionTenant: async () => null,
  setSessionTenant: async () => {},
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));
vi.mock("@/services/personalization/documents", () => ({
  MAX_DOCUMENT_BYTES: 25 * 1024 * 1024,
  DocumentError: class extends Error {},
  deleteDocument: vi.fn(),
  listDocuments: vi.fn(),
  replaceDocument: vi.fn(),
  setDocumentStatus: vi.fn(),
  signedDownloadUrl: vi.fn(),
  uploadDocument: vi.fn(),
}));

import {
  CHAT_DOC_MAX_BYTES,
  CHAT_VIDEO_MAX_BYTES,
  chatDocUploadChain,
  chatVideoUploadChain,
} from "@/routes/chat/upload-doc";
import {
  personalizationReplaceChain,
  personalizationUploadChain,
} from "@/routes/personalization/documents";
import { extensionScreenshotChain } from "@/routes/extension/screenshot";
import { WORKSPACE_FILE_MAX_BYTES, workspaceFilesUploadChain } from "@/routes/workspace/workspace-files";

const DOC_ID = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const ROUTES = [
  { path: "/api/extension/screenshot", chain: extensionScreenshotChain, cap: 5 * 1024 * 1024 },
  { path: "/api/chat/upload-doc", chain: chatDocUploadChain, cap: CHAT_DOC_MAX_BYTES },
  { path: "/api/chat/upload-video", chain: chatVideoUploadChain, cap: CHAT_VIDEO_MAX_BYTES },
  { path: "/api/personalization/documents", chain: personalizationUploadChain, cap: 25 * 1024 * 1024 },
  {
    path: `/api/personalization/documents/${DOC_ID}/replace`,
    mount: "/api/personalization/documents/:id/replace",
    chain: personalizationReplaceChain,
    cap: 25 * 1024 * 1024,
  },
  {
    path: "/api/workspace/files",
    chain: workspaceFilesUploadChain,
    cap: WORKSPACE_FILE_MAX_BYTES,
    field: "files",
    tooLargeStatus: 413,
  },
];

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  for (const r of ROUTES) app.post(r.mount ?? r.path, ...r.chain);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  bearerValid = false;
});

async function postOversized(path: string, cap: number, withBearer: boolean, field = "file") {
  const form = new FormData();
  form.append(field, new Blob([new Uint8Array(cap + 1024)]), "big.pdf");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    body: form,
    headers: withBearer ? { Authorization: "Bearer tok" } : {},
  });
  return { status: res.status, body: (await res.json()) as { error?: { code?: string } } };
}

describe("upload routes authenticate before multer buffers the body", () => {
  it.each(ROUTES)("$path: no bearer → 401, never file_too_large", async (r) => {
    const { status, body } = await postOversized(r.path, r.cap, false, "field" in r ? r.field : undefined);
    expect(status).toBe(401);
    expect(body.error?.code).toBe("unauthenticated");
  });

  it.each(ROUTES)("$path: valid bearer → multer still enforces the cap", async (r) => {
    bearerValid = true;
    const { status, body } = await postOversized(r.path, r.cap, true, "field" in r ? r.field : undefined);
    expect(status).toBe("tooLargeStatus" in r ? r.tooLargeStatus : 400);
    expect(body.error?.code).toBe("file_too_large");
  });

  it.each(ROUTES)("$path: chain starts with authMiddleware", async ({ chain }) => {
    const { authMiddleware } = await import("@/services/auth/middleware");
    expect(chain[0]).toBe(authMiddleware);
  });
});
