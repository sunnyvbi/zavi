
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const getSecret = vi.fn();
vi.mock("@/services/secrets/vault", () => ({ getSecret: (...a: unknown[]) => getSecret(...a) }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { figmaCreds } from "../_client";
import { figmaListFilesTool } from "../list_files";
import { figmaGetFileTool } from "../get_file";

const ctx = { tenant_id: "t-1", log: () => {} };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  getSecret.mockReset();
  fetchMock.mockReset();
});

describe("figmaCreds fails closed", () => {
  it("throws figma_not_connected when no secret exists", async () => {
    getSecret.mockResolvedValue(null);
    const err = await figmaCreds("t-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("figma_not_connected");
    expect(err.message).toMatch(/Settings/);
  });

  it("resolves creds from the stored secret", async () => {
    getSecret.mockResolvedValue("figd_test_token");
    const creds = await figmaCreds("t-1");
    expect(creds.api_key).toBe("figd_test_token");
  });
});

describe("figma_list_files input validation", () => {
  it("rejects when neither project_id nor team_id is given", async () => {
    getSecret.mockResolvedValue("figd_test_token");
    await expect(figmaListFilesTool.execute(ctx, {})).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when both project_id and team_id are given", async () => {
    getSecret.mockResolvedValue("figd_test_token");
    await expect(
      figmaListFilesTool.execute(ctx, { project_id: "p1", team_id: "t1" }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists files for a project_id via GET /v1/projects/:id/files", async () => {
    getSecret.mockResolvedValue("figd_test_token");
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: "Design Project",
        files: [{ key: "abc123", name: "Homepage", last_modified: "2026-08-01T00:00:00Z" }],
      }),
    );
    const result = (await figmaListFilesTool.execute(ctx, { project_id: "p1" })) as {
      kind: string;
      files: Array<{ file_key: string | null }>;
    };
    expect(result.kind).toBe("files");
    expect(result.files[0].file_key).toBe("abc123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.figma.com/v1/projects/p1/files");
    expect((init.headers as Record<string, string>)["X-Figma-Token"]).toBe("figd_test_token");
  });

  it("lists projects for a team_id via GET /v1/teams/:id/projects and never fans out to files", async () => {
    getSecret.mockResolvedValue("figd_test_token");
    fetchMock.mockResolvedValue(
      jsonResponse({ projects: [{ id: "p1", name: "Marketing" }] }),
    );
    const result = (await figmaListFilesTool.execute(ctx, { team_id: "team1" })) as {
      kind: string;
      projects: Array<{ project_id: string | null }>;
    };
    expect(result.kind).toBe("projects");
    expect(result.projects[0].project_id).toBe("p1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 401/403 to figma_key_rejected without leaking the response body", async () => {
    getSecret.mockResolvedValue("figd_bad_token");
    fetchMock.mockResolvedValue(jsonResponse({ status: 403, err: "Invalid token" }, 403));
    const err = (await figmaListFilesTool
      .execute(ctx, { project_id: "p1" })
      .catch((e) => e)) as ExpectedToolError;
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("figma_key_rejected");
    expect(err.message).not.toMatch(/Invalid token/);
  });
});

describe("figma_get_file tree trimming", () => {
  it("requests the bounded depth and strips node fields down to id/name/type/children", async () => {
    getSecret.mockResolvedValue("figd_test_token");
    fetchMock.mockResolvedValue(
      jsonResponse({
        name: "My File",
        lastModified: "2026-08-01T00:00:00Z",
        document: {
          id: "0:0",
          name: "Document",
          type: "DOCUMENT",
          fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
          children: [{ id: "1:1", name: "Page 1", type: "CANVAS", children: [] }],
        },
      }),
    );
    const result = (await figmaGetFileTool.execute(ctx, { file_key: "abc", depth: 2 })) as {
      document: { id?: string; name?: string; type?: string; children?: unknown[] } | null;
      truncated: boolean;
    };
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.figma.com/v1/files/abc?depth=2");
    expect(result.document).not.toBeNull();
    expect(result.document).not.toHaveProperty("fills");
    expect(result.document?.name).toBe("Document");
    expect(result.document?.children?.[0]).toEqual({ id: "1:1", name: "Page 1", type: "CANVAS", children: [] });
    expect(result.truncated).toBe(false);
  });

  it("clamps a depth above the hard max instead of forwarding it to Figma", async () => {
    getSecret.mockResolvedValue("figd_test_token");
    fetchMock.mockResolvedValue(
      jsonResponse({ document: { id: "0:0", name: "Document", type: "DOCUMENT" } }),
    );
    await figmaGetFileTool.execute(ctx, { file_key: "abc", depth: 999 }).catch(() => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates a tree wider than the node cap and sets the truncated flag", async () => {
    getSecret.mockResolvedValue("figd_test_token");
    const manyChildren = Array.from({ length: 1500 }, (_, i) => ({
      id: `1:${i}`,
      name: `Frame ${i}`,
      type: "FRAME",
    }));
    fetchMock.mockResolvedValue(
      jsonResponse({
        document: { id: "0:0", name: "Document", type: "DOCUMENT", children: manyChildren },
      }),
    );
    const result = (await figmaGetFileTool.execute(ctx, { file_key: "abc" })) as {
      truncated: boolean;
      node_count: number;
      note?: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.node_count).toBeLessThanOrEqual(1201);
    expect(result.note).toMatch(/Truncated/);
  });
});
