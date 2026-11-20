
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(), authMiddleware: vi.fn() }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn() }));

import { CHAT_DOC_MAX_BYTES, CHAT_VIDEO_MAX_BYTES } from "@/routes/chat/upload-doc";
import { MAX_DOCUMENT_BYTES } from "@/services/personalization/documents";
import {
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_FILE_MAX_COUNT,
  WORKSPACE_UPLOAD_MAX_REQUEST_BYTES,
} from "@/services/workspace-files/workspace-files";

const conf = readFileSync(
  join(__dirname, "../../../../../infra/nginx/api.zaviagent.com.conf"),
  "utf-8",
);

function locationBody(matcher: string): string {
  const open = `location ${matcher} {`;
  const start = conf.indexOf(open);
  expect(start, `missing nginx location ${matcher}`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + open.length;
  return conf.slice(bodyStart, conf.indexOf("\n    }", bodyStart));
}

function toBytes(size: string): number {
  const m = /^(\d+)([kKmMgG]?)$/.exec(size);
  if (!m) throw new Error(`unparseable nginx size: ${size}`);
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()]!;
  return Number(m[1]) * mult;
}

function capOf(body: string): number {
  const m = /client_max_body_size\s+(\S+);/.exec(body);
  if (!m) throw new Error("location has no client_max_body_size");
  return toBytes(m[1]);
}

const UPLOAD_LOCATIONS = [
  { matcher: "= /api/chat/upload-video", appCap: CHAT_VIDEO_MAX_BYTES },
  { matcher: "= /api/chat/upload-doc", appCap: CHAT_DOC_MAX_BYTES },
  { matcher: "= /api/workspace/files", appCap: WORKSPACE_UPLOAD_MAX_REQUEST_BYTES },
  {
    matcher: '~* "^/api/personalization/documents(/[0-9a-f-]{36}/replace)?/?$"',
    appCap: MAX_DOCUMENT_BYTES,
  },
];

describe("nginx upload locations vs Express multer caps", () => {
  it.each(UPLOAD_LOCATIONS)("$matcher allows the app cap plus multipart overhead", ({ matcher, appCap }) => {
    expect(capOf(locationBody(matcher))).toBeGreaterThanOrEqual(appCap * 1.05);
  });

  it.each(UPLOAD_LOCATIONS)("$matcher buffers the body before proxying", ({ matcher }) => {
    expect(locationBody(matcher)).toMatch(/proxy_request_buffering\s+on;/);
  });

  it.each(UPLOAD_LOCATIONS)("$matcher proxies exactly like `location /`", ({ matcher }) => {
    const body = locationBody(matcher);
    expect(body).toMatch(/proxy_pass http:\/\/praxis_backend;/);
    expect(body).toMatch(/proxy_http_version 1\.1;/);
    expect(body).toMatch(/proxy_set_header Connection "";/);
  });

  it("personalization regex matches upload + replace and nothing else", () => {
    const pattern = /location ~\* "([^"]+)" \{/.exec(conf)?.[1];
    expect(pattern, "personalization regex location not found").toBeTruthy();
    const re = new RegExp(pattern!, "i");
    const id = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
    expect(re.test("/api/personalization/documents")).toBe(true);
    expect(re.test(`/api/personalization/documents/${id}/replace`)).toBe(true);
    expect(re.test(`/api/personalization/documents/${id.toUpperCase()}/replace`)).toBe(true);
    expect(re.test(`/api/personalization/documents/${id}/archive`)).toBe(false);
    expect(re.test(`/api/personalization/documents/${id}/url`)).toBe(false);
  });

  it("the workspace files cap covers a full batch of max-size photos", () => {
    expect(WORKSPACE_UPLOAD_MAX_REQUEST_BYTES).toBeGreaterThanOrEqual(WORKSPACE_FILE_MAX_BYTES * WORKSPACE_FILE_MAX_COUNT);
    expect(capOf(locationBody("= /api/workspace/files"))).toBeGreaterThanOrEqual(
      WORKSPACE_FILE_MAX_BYTES * WORKSPACE_FILE_MAX_COUNT * 1.05,
    );
  });

  it("the workspace files location forwards the caller's address like `location /`", () => {
    const body = locationBody("= /api/workspace/files");
    expect(body).toMatch(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
    expect(body).toMatch(/proxy_set_header X-Real-IP \$remote_addr;/);
    expect(body).toMatch(/proxy_set_header Host \$host;/);
  });

  it("keeps the 6M server-wide cap for every other route", () => {
    const serverLevel = conf.slice(0, conf.search(/^\s*location\s/m));
    expect(capOf(serverLevel)).toBe(6 * 1024 * 1024);
  });
});
