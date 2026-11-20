import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  downloadSlackFileBytes: vi.fn(),
}));

vi.mock("@/services/tools/slack/_client", () => ({
  downloadSlackFileBytes: (...a: unknown[]) => m.downloadSlackFileBytes(...a),
}));

import {
  resolveSlackImageContent,
  normalizeSlackImageRefs,
} from "../slack-inbound-image";

const TENANT = "00000000-0000-0000-0000-000000000abc";
const TEAM = "T0TEAM";

beforeEach(() => {
  m.downloadSlackFileBytes.mockReset();
});

describe("normalizeSlackImageRefs", () => {
  it("drops malformed entries + caps at 4", () => {
    const refs = normalizeSlackImageRefs([
      { url: "https://files.slack.com/a.png", mimetype: "image/png" },
      { url: "", mimetype: "image/png" },
      { mimetype: "image/png" },
      "not-an-object",
      { url: "https://files.slack.com/b.png", mimetype: "image/png" },
      { url: "https://files.slack.com/c.png", mimetype: "image/png" },
      { url: "https://files.slack.com/d.png", mimetype: "image/png" },
      { url: "https://files.slack.com/e.png", mimetype: "image/png" },
    ]);
    expect(refs).toHaveLength(4);
  });

  it("returns [] for non-array", () => {
    expect(normalizeSlackImageRefs(undefined)).toEqual([]);
    expect(normalizeSlackImageRefs("x")).toEqual([]);
  });
});

describe("resolveSlackImageContent", () => {
  it("builds a base64 image block per downloaded image + trailing intent text", async () => {
    m.downloadSlackFileBytes.mockResolvedValue(Buffer.from("PNGBYTES"));
    const content = (await resolveSlackImageContent(
      TENANT,
      TEAM,
      [{ url: "https://files.slack.com/a.png", mimetype: "image/png", name: "shot.png" }],
      "Can you fix this issue",
    )) as unknown as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: Buffer.from("PNGBYTES").toString("base64") },
    });
    expect(content[1]).toMatchObject({ type: "text", text: "Can you fix this issue" });
    expect(m.downloadSlackFileBytes).toHaveBeenCalledWith(TENANT, "https://files.slack.com/a.png", TEAM);
  });

  it("maps image/jpg → image/jpeg media_type", async () => {
    m.downloadSlackFileBytes.mockResolvedValue(Buffer.from("J"));
    const content = (await resolveSlackImageContent(
      TENANT, TEAM,
      [{ url: "https://files.slack.com/a.jpg", mimetype: "image/jpg" }],
      "x",
    )) as unknown as Array<Record<string, unknown>>;
    expect((content[0] as { source: { media_type: string } }).source.media_type).toBe("image/jpeg");
  });

  it("unsupported mimetype → visible failure marker, no download attempted", async () => {
    const content = (await resolveSlackImageContent(
      TENANT, TEAM,
      [{ url: "https://files.slack.com/a.tiff", mimetype: "image/tiff", name: "a.tiff" }],
      "intent",
    )) as unknown as Array<Record<string, unknown>>;
    expect(m.downloadSlackFileBytes).not.toHaveBeenCalled();
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("unsupported format") });
    expect(content[content.length - 1]).toMatchObject({ type: "text", text: "intent" });
  });

  it("download returns null → visible 'could not be loaded' marker, run not broken", async () => {
    m.downloadSlackFileBytes.mockResolvedValue(null);
    const content = (await resolveSlackImageContent(
      TENANT, TEAM,
      [{ url: "https://files.slack.com/a.png", mimetype: "image/png", name: "a.png" }],
      "intent",
    )) as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not be loaded") });
  });

  it("declared-oversize image → skipped before download, visible 'too large' marker", async () => {
    const content = (await resolveSlackImageContent(
      TENANT, TEAM,
      [{ url: "https://files.slack.com/big.png", mimetype: "image/png", name: "big.png", size: 9 * 1024 * 1024 }],
      "intent",
    )) as unknown as Array<Record<string, unknown>>;
    expect(m.downloadSlackFileBytes).not.toHaveBeenCalled();
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("too large") });
  });

  it("zero image refs → returns null (caller keeps text-only turn)", async () => {
    expect(await resolveSlackImageContent(TENANT, TEAM, [], "x")).toBeNull();
    expect(await resolveSlackImageContent(TENANT, TEAM, undefined, "x")).toBeNull();
  });

  it("mixes good + bad: image block AND marker both present", async () => {
    m.downloadSlackFileBytes
      .mockResolvedValueOnce(Buffer.from("OK"))
      .mockResolvedValueOnce(null);
    const content = (await resolveSlackImageContent(
      TENANT, TEAM,
      [
        { url: "https://files.slack.com/ok.png", mimetype: "image/png", name: "ok.png" },
        { url: "https://files.slack.com/bad.png", mimetype: "image/png", name: "bad.png" },
      ],
      "intent",
    )) as unknown as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({ type: "image" });
    expect(content[1]).toMatchObject({ type: "text", text: expect.stringContaining("could not be loaded") });
    expect(content[2]).toMatchObject({ type: "text", text: "intent" });
  });
});
