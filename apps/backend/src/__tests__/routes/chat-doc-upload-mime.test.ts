
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const USER_A = "22222222-bbbb-bbbb-bbbb-222222222222";

vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(), authMiddleware: vi.fn() }));
let sbImpl: () => unknown = () => ({});
vi.mock("@/services/supabase", () => ({ serviceClient: () => sbImpl() }));

import { requireAuth } from "@/services/auth/middleware";
import { chatDocUpload } from "@/routes/chat/upload-doc";

const BUCKET_ALLOWED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "text/plain",
];

function mkRes(): Response & { _status: number; _body: unknown } {
  const r: Partial<Response> & { _status: number; _body: unknown } = {
    _status: 200,
    _body: undefined,
    status(code: number) {
      r._status = code;
      return r as Response;
    },
    json(body: unknown) {
      r._body = body;
      return r as Response;
    },
  };
  return r as Response & { _status: number; _body: unknown };
}

const mkReq = (originalname: string, mimetype: string, buffer: Buffer) =>
  ({ file: { originalname, mimetype, buffer } }) as unknown as Request;

let uploadSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  uploadSpy = vi.fn().mockResolvedValue({ data: { path: "stored" }, error: null });
  sbImpl = () => ({
    storage: { from: () => ({ upload: uploadSpy }) },
  });
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user_id: USER_A,
    tenant_id: TENANT_A,
    access_token: "fake",
  });
});

const contentTypeOf = () =>
  (uploadSpy.mock.calls[0]?.[2] as { contentType?: string } | undefined)?.contentType;

describe("chatDocUpload — Content-Type normalization", () => {
  it("stores a .csv as text/csv even when the browser says application/vnd.ms-excel", async () => {
    const res = mkRes();
    await chatDocUpload(
      mkReq("report.csv", "application/vnd.ms-excel", Buffer.from("a,b\n1,2\n")),
      res,
    );

    expect(res._status).toBe(200);
    expect(contentTypeOf()).toBe("text/csv");
  });

  it("stores a .csv as text/csv when the browser gives up and says octet-stream", async () => {
    await chatDocUpload(
      mkReq("report.csv", "application/octet-stream", Buffer.from("a,b\n1,2\n")),
      mkRes(),
    );

    expect(contentTypeOf()).toBe("text/csv");
  });

  it.each([
    ["notes.txt", "application/octet-stream", "text/plain"],
    ["spec.docx", "application/octet-stream", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["deck.pdf", "application/octet-stream", "application/pdf"],
  ])("derives %s → %s regardless of the sent header", async (name, sent, expected) => {
    const buf = name.endsWith(".pdf")
      ? Buffer.from("%PDF-1.7\n")
      : Buffer.from("hello");
    await chatDocUpload(mkReq(name, sent, buf), mkRes());

    expect(contentTypeOf()).toBe(expected);
  });

  it("only ever stores a MIME the bucket actually allows", async () => {
    for (const [name, buf] of [
      ["a.csv", Buffer.from("x")],
      ["a.txt", Buffer.from("x")],
      ["a.docx", Buffer.from("x")],
      ["a.pdf", Buffer.from("%PDF-1.7\n")],
    ] as const) {
      uploadSpy.mockClear();
      await chatDocUpload(mkReq(name, "text/x-nonsense", buf), mkRes());
      expect(BUCKET_ALLOWED_MIME).toContain(contentTypeOf());
    }
  });

  it("still rejects an unsupported extension before it reaches storage", async () => {
    const res = mkRes();
    await chatDocUpload(mkReq("sheet.xlsx", "text/csv", Buffer.from("x")), res);

    expect(res._status).toBe(400);
    expect((res._body as { error: { code: string } }).error.code).toBe(
      "unsupported_extension",
    );
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

describe("chatDocUpload — the extension allowlist is own-keys only", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "rejects a .%s file instead of letting a prototype key pass the allowlist",
    async (protoKey) => {
      const res = mkRes();
      await chatDocUpload(
        mkReq(`payload.${protoKey}`, "application/octet-stream", Buffer.from("x")),
        res,
      );
      expect(res._status).toBe(400);
    },
  );

  it.each([
    ["a.csv", "text/csv"],
    ["a.txt", "text/plain"],
  ])("still accepts %s", async (name, mime) => {
    await chatDocUpload(mkReq(name, "application/octet-stream", Buffer.from("x")), mkRes());
    expect(contentTypeOf()).toBe(mime);
  });
});

describe("chatDocUpload — markdown is stored as text", () => {
  it.each(["notes.md", "NOTES.MD", "plan.markdown"])(
    "accepts %s and stores it under .txt as text/plain",
    async (name) => {
      const bytes = Buffer.from("# Plan\n\n- one\n");
      const res = mkRes();
      await chatDocUpload(mkReq(name, "text/markdown", bytes), res);

      expect(res._status).toBe(200);
      expect(contentTypeOf()).toBe("text/plain");
      const storedPath = uploadSpy.mock.calls[0]?.[0] as string;
      expect(storedPath).toMatch(new RegExp(`^${TENANT_A}/[0-9a-f-]{36}\\.txt$`));
      expect(uploadSpy.mock.calls[0]?.[1]).toBe(bytes);
      expect((res._body as { doc_path: string }).doc_path).toBe(storedPath);
    },
  );
});
