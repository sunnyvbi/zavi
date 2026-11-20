import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

vi.mock("@/services/supabase", async () => {
  const { fake } = await import("@/services/workspace-files/__tests__/fake-supabase");
  return { serviceClient: () => fake.client() };
});
vi.hoisted(() => {
  process.env.BACKEND_PUBLIC_URL = "https://api.test.zavi/";
});
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (req: { headers: Record<string, string | undefined> }) => ({
    tenant_id: req.headers["x-test-tenant"] ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    user_id: req.headers["x-test-user"] ?? "user-1",
    access_token: "t",
  })),
}));

import { _resetIndexMemoForTest } from "@/services/workspace-files/workspace-files";
import { fake, filesOf, indexKey, seedRole } from "@/services/workspace-files/__tests__/fake-supabase";
import { chatImageUpload, chatImageUploadMiddleware } from "../upload-image";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let server: Server;
let base: string;
let png: Buffer;

beforeAll(async () => {
  png = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 0.5 } } })
    .png()
    .toBuffer();
  const app = express();
  app.post("/api/chat/upload-image", chatImageUploadMiddleware, chatImageUpload);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  fake.reset();
  _resetIndexMemoForTest();
  seedRole(A, "user-1", "owner");
  seedRole(B, "user-1", "owner");
});

async function send(query: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "storefront.png");
  const res = await fetch(`${base}/api/chat/upload-image${query}`, { method: "POST", body: form, headers });
  return { status: res.status, body: (await res.json()) as { image_path: string; saved_to_files: boolean } };
}

function chatObject(path: string): Buffer | undefined {
  return fake.state.objects.get(`agent-chat-images/${path}`)?.body;
}

function workspaceObjects(tenant: string): Array<[string, Buffer]> {
  return [...fake.state.objects.entries()]
    .filter(([k]) => k.startsWith(`tenant-documents/${tenant}/workspace-files/`) && k !== indexKey(tenant))
    .map(([k, v]) => [k, v.body]);
}

describe("POST /api/chat/upload-image?save_to_files=1", () => {
  it("registers the same normalized JPEG in the caller's Files as an image", async () => {
    const res = await send("?save_to_files=1");
    expect(res.status).toBe(200);
    expect(res.body.saved_to_files).toBe(true);

    const rows = filesOf(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mime: "image/jpeg", uploaded_by: "user-1" });
    expect(String(rows[0]!.name)).toMatch(/^storefront.*\.jpg$/);

    const objs = workspaceObjects(A);
    expect(objs).toHaveLength(1);
    const chatBytes = chatObject(res.body.image_path)!;
    expect(objs[0]![1].equals(chatBytes)).toBe(true);
    expect(chatBytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);

    expect(workspaceObjects(B)).toEqual([]);
    expect(filesOf(B)).toEqual([]);
  });

  it("writes into the authenticated tenant, never another one", async () => {
    await send("?save_to_files=1", { "x-test-tenant": B });
    expect(filesOf(B)).toHaveLength(1);
    expect(fake.state.objects.has(indexKey(A))).toBe(false);
  });

  it("leaves Files untouched without the opt-in flag (feedback screenshots share this route)", async () => {
    const res = await send("");
    expect(res.status).toBe(200);
    expect(res.body.saved_to_files).toBe(false);
    expect(chatObject(res.body.image_path)).toBeTruthy();
    expect(fake.state.objects.has(indexKey(A))).toBe(false);
  });

  it("does not let a plain member write Files through chat", async () => {
    const res = await send("?save_to_files=1", { "x-test-user": "member-1" });
    seedRole(A, "member-1", "member");
    const res2 = await send("?save_to_files=1", { "x-test-user": "member-1" });
    for (const r of [res, res2]) {
      expect(r.status).toBe(200);
      expect(r.body.saved_to_files).toBe(false);
      expect(chatObject(r.body.image_path)).toBeTruthy();
    }
    expect(fake.state.objects.has(indexKey(A))).toBe(false);
  });

  it("still returns the chat attachment when the Files write fails, and leaves no orphan object", async () => {
    fake.state.failIndexWrite = { message: "storage down" };
    const res = await send("?save_to_files=1");
    expect(res.status).toBe(200);
    expect(res.body.saved_to_files).toBe(false);
    expect(chatObject(res.body.image_path)).toBeTruthy();
    expect(workspaceObjects(A)).toEqual([]);
  });
});
