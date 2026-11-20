import { describe, it, expect } from "vitest";
import {
  readGoogleFileViaPipedream,
  extractDownloadedText,
  type PipedreamToolCaller,
} from "../google-drive-pipedream";
import type { GoogleFileRef } from "../google-drive-core";

const DOC_REF: GoogleFileRef = { file_id: "abc123", kind: "document", gid: null };
const TOOLS = [
  "google_drive-search-files",
  "google_drive-get-file",
  "google_drive-download-file",
  "google_drive-create-file-from-text",
];

const okMeta = (mimeType: string, name = "Q3 Recommendations") =>
  JSON.stringify({ id: "abc123", name, mimeType });

function caller(map: Record<string, { is_error?: boolean; content: string }>): {
  fn: PipedreamToolCaller;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fn: PipedreamToolCaller = async (tool_name, args) => {
    calls.push({ tool: tool_name, args });
    for (const [k, v] of Object.entries(map)) {
      if (tool_name.includes(k)) return { is_error: v.is_error ?? false, content: v.content };
    }
    return { is_error: true, content: "{}" };
  };
  return { fn, calls };
}

describe("readGoogleFileViaPipedream", () => {
  it("reads a Google Doc and forces a TEXT export mimeType", async () => {
    const { fn, calls } = caller({
      "get-file": { content: okMeta("application/vnd.google-apps.document") },
      "download-file": { content: JSON.stringify({ content: "Hello from the doc body." }) },
    });
    const res = await readGoogleFileViaPipedream(DOC_REF, TOOLS, fn);

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.name).toBe("Q3 Recommendations");
    expect(res.body_text).toContain("Hello from the doc body.");
    expect(res.body_text).toContain("<untrusted_web_content>");

    const dl = calls.find((c) => c.tool.includes("download-file"));
    expect(dl?.args.mimeType).toBe("text/plain");
    expect(dl?.args.getBufferResponse).toBe(true);
    expect(dl?.args.fileId).toBe("abc123");
  });

  it("exports a Sheet as CSV and warns that only the first tab was read", async () => {
    const { fn, calls } = caller({
      "get-file": { content: okMeta("application/vnd.google-apps.spreadsheet", "Budget") },
      "download-file": { content: JSON.stringify({ content: "a,b\n1,2" }) },
    });
    const res = await readGoogleFileViaPipedream(
      { file_id: "s1", kind: "spreadsheet", gid: "77" },
      TOOLS,
      fn,
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(calls.find((c) => c.tool.includes("download-file"))?.args.mimeType).toBe("text/csv");
    expect(res.body_text).toContain("FIRST TAB ONLY");
    expect(res.body_text).toContain("not honored");
  });

  it("maps a metadata failure to access_required, not a generic error", async () => {
    const { fn } = caller({
      "get-file": { is_error: true, content: "boom" },
    });
    const res = await readGoogleFileViaPipedream(DOC_REF, TOOLS, fn);
    expect(res.status).toBe("access_required");
    if (res.status === "ok") return;
    expect(res.message).toContain("share it with");
  });

  it("refuses a folder link", async () => {
    const { fn } = caller({
      "get-file": { content: okMeta("application/vnd.google-apps.folder", "Team Drive") },
    });
    const res = await readGoogleFileViaPipedream(DOC_REF, TOOLS, fn);
    expect(res.status).toBe("unsupported");
    if (res.status === "ok") return;
    expect(res.message).toContain("folder");
  });

  it("refuses a binary Drive file instead of feeding bytes to the model", async () => {
    const { fn } = caller({
      "get-file": { content: okMeta("image/png", "screenshot.png") },
    });
    const res = await readGoogleFileViaPipedream(DOC_REF, TOOLS, fn);
    expect(res.status).toBe("unsupported");
  });

  it("fails loudly when the download comes back as a binary blob", async () => {
    const zipish = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]).toString("utf8");
    const { fn } = caller({
      "get-file": { content: okMeta("application/vnd.google-apps.document") },
      "download-file": { content: JSON.stringify({ content: zipish }) },
    });
    const res = await readGoogleFileViaPipedream(DOC_REF, TOOLS, fn);
    expect(res.status).toBe("error");
    if (res.status === "ok") return;
    expect(res.message).toContain("non-text format");
  });

  it("errors cleanly when no download tool is advertised", async () => {
    const { fn } = caller({});
    const res = await readGoogleFileViaPipedream(DOC_REF, ["google_drive-search-files"], fn);
    expect(res.status).toBe("error");
    if (res.status === "ok") return;
    expect(res.message).toContain("reconnect Google Drive");
  });

  it("does not mistake create-file-from-text for the download tool", async () => {
    const { fn, calls } = caller({
      "get-file": { content: okMeta("application/vnd.google-apps.document") },
      "download-file": { content: JSON.stringify({ content: "body" }) },
    });
    await readGoogleFileViaPipedream(DOC_REF, TOOLS, fn);
    expect(calls.some((c) => c.tool.includes("create-file-from-text"))).toBe(false);
  });
});

describe("extractDownloadedText", () => {
  it("decodes a node Buffer JSON payload", () => {
    const buf = Buffer.from("plain text body", "utf8");
    expect(extractDownloadedText({ content: { type: "Buffer", data: [...buf] } })).toBe(
      "plain text body",
    );
  });

  it("decodes a base64 string payload", () => {
    const b64 = Buffer.from("base64 body", "utf8").toString("base64");
    expect(extractDownloadedText({ fileContent: b64 })).toBe("base64 body");
  });

  it("accepts already-decoded text", () => {
    expect(extractDownloadedText({ text: "already decoded, with punctuation." })).toBe(
      "already decoded, with punctuation.",
    );
  });

  it("finds content nested in a batch array", () => {
    expect(extractDownloadedText({ files: [{ content: "from a batch" }] })).toBe("from a batch");
  });

  it("returns null for binary content rather than guessing", () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]).toString("utf8");
    expect(extractDownloadedText({ content: bin })).toBeNull();
  });

  it("returns null when nothing recognizable is present", () => {
    expect(extractDownloadedText({ unrelated: 42 })).toBeNull();
  });
});
