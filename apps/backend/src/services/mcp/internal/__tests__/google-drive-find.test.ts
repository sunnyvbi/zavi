
import { describe, it, expect } from "vitest";
import {
  buildDriveSearchQuery,
  escapeDriveQueryTerm,
  findGoogleFiles,
  MAX_FIND_RESULTS,
  type GoogleAuth,
} from "../google-drive-core";

const AUTH: GoogleAuth = { access_token: "test-token", account_email: "ops@example.com" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mkFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fn, calls };
}

function file(n: number) {
  return {
    id: `id-${n}`,
    name: `Doc ${n}`,
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-09-01T00:00:00.000Z",
    webViewLink: `https://docs.google.com/document/d/id-${n}/edit`,
  };
}

describe("buildDriveSearchQuery", () => {
  it("searches name AND full text, and excludes trashed files", () => {
    const q = buildDriveSearchQuery("non-return procedure");
    expect(q).toBe(
      "trashed = false and (name contains 'non-return procedure' or fullText contains 'non-return procedure')",
    );
  });

  it("trims the term before embedding it", () => {
    expect(buildDriveSearchQuery("  refund policy  ")).toContain("'refund policy'");
  });

  it("escapes a quote so a term cannot terminate the q literal", () => {
    const q = buildDriveSearchQuery("driver's handbook");
    expect(q).toContain("\\'");
    expect(q).not.toContain("'driver's handbook'");
  });

  it("escapes backslashes before quotes, so the escape is not itself escaped", () => {
    expect(escapeDriveQueryTerm("a\\b")).toBe("a\\\\b");
    expect(escapeDriveQueryTerm("a'b")).toBe("a\\'b");
    expect(escapeDriveQueryTerm("a\\")).toBe("a\\\\");
  });
});

describe("findGoogleFiles — request shape", () => {
  it("asks Drive for metadata only, one page, newest first", async () => {
    const { fn, calls } = mkFetch(() => json(200, { files: [file(1)] }));
    await findGoogleFiles("support templates", AUTH, fn);

    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]);
    expect(u.pathname).toBe("/drive/v3/files");
    expect(u.searchParams.get("q")).toBe(buildDriveSearchQuery("support templates"));
    expect(u.searchParams.get("pageSize")).toBe(String(MAX_FIND_RESULTS + 1));
    expect(u.searchParams.get("orderBy")).toBe("modifiedTime desc");
    const fields = u.searchParams.get("fields") ?? "";
    expect(fields).toBe("files(id,name,mimeType,modifiedTime,webViewLink),incompleteSearch");
    expect(fields).not.toMatch(/content|body|export/i);
    expect(u.searchParams.get("pageToken")).toBeNull();
    expect(u.searchParams.get("supportsAllDrives")).toBe("true");
  });

  it("sends the tenant's own bearer token and nothing else", async () => {
    let auth: string | null = null;
    const fn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return json(200, { files: [] });
    }) as typeof fetch;
    await findGoogleFiles("anything", AUTH, fn);
    expect(auth).toBe("Bearer test-token");
  });

  it("refuses an empty term without calling Drive", async () => {
    const { fn, calls } = mkFetch(() => json(200, { files: [] }));
    const out = await findGoogleFiles("   ", AUTH, fn);
    expect(out.status).toBe("error");
    expect(calls).toHaveLength(0);
  });
});

describe("findGoogleFiles — result cap and truncation markers", () => {
  it("caps the result set and marks it as truncated", async () => {
    const overflow = Array.from({ length: MAX_FIND_RESULTS + 1 }, (_, i) => file(i));
    const { fn } = mkFetch(() => json(200, { files: overflow }));
    const out = await findGoogleFiles("policy", AUTH, fn);

    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.files).toHaveLength(MAX_FIND_RESULTS);
    expect(out.truncated).toBe(true);
    expect(out.notes.join(" ")).toContain("[truncated:");
    expect(out.notes.join(" ")).toContain(String(MAX_FIND_RESULTS));
  });

  it("emits NO marker when the result really is complete", async () => {
    const { fn } = mkFetch(() => json(200, { files: [file(1), file(2)] }));
    const out = await findGoogleFiles("policy", AUTH, fn);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.files).toHaveLength(2);
    expect(out.truncated).toBe(false);
    expect(out.notes).toEqual([]);
  });

  it("surfaces Google's incompleteSearch as its own marker, so an empty result is not read as an absence", async () => {
    const { fn } = mkFetch(() => json(200, { files: [], incompleteSearch: true }));
    const out = await findGoogleFiles("non-return", AUTH, fn);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.files).toEqual([]);
    expect(out.notes.join(" ")).toContain("[incomplete:");
    expect(out.notes.join(" ")).toContain("NOT proof");
  });

  it("truncates a runaway file name so it cannot crowd out the other rows", async () => {
    const long = { ...file(1), name: "x".repeat(500) };
    const { fn } = mkFetch(() => json(200, { files: [long] }));
    const out = await findGoogleFiles("x", AUTH, fn);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.files[0].name).toContain("[name truncated]");
    expect(out.files[0].name.length).toBeLessThan(500);
  });

  it("maps Drive rows to the metadata shape, tolerating missing optional fields", async () => {
    const { fn } = mkFetch(() =>
      json(200, { files: [{ id: "abc", name: "Support Templates", mimeType: "application/vnd.google-apps.document" }] }),
    );
    const out = await findGoogleFiles("support templates", AUTH, fn);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.files[0]).toEqual({
      file_id: "abc",
      name: "Support Templates",
      mime_type: "application/vnd.google-apps.document",
      modified_time: null,
      web_view_link: null,
    });
  });
});

describe("findGoogleFiles — failures", () => {
  it("returns auth_stale on 401 so the caller re-mints the token", async () => {
    const { fn } = mkFetch(() => json(401, { error: "invalid" }));
    const out = await findGoogleFiles("policy", AUTH, fn);
    expect(out.status).toBe("auth_stale");
  });

  it("carries Google's own reason on a 403, so an insufficient scope is not mistaken for a rate limit", async () => {
    const { fn } = mkFetch(() =>
      json(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }),
    );
    const out = await findGoogleFiles("policy", AUTH, fn);
    expect(out.status).toBe("error");
    if (out.status === "ok") return;
    expect(out.message).toContain("403");
    expect(out.message).toContain("insufficientPermissions");
  });
});
