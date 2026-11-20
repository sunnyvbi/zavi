
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/secrets/vault", () => ({
  getSecret: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(),
}));

import { getSecret } from "@/services/secrets/vault";
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { ExpectedToolError } from "@/services/tools/types";

const mockedGetSecret = getSecret as unknown as ReturnType<typeof vi.fn>;
const mockedServiceClient = serviceClient as unknown as ReturnType<typeof vi.fn>;

const TENANT = "00000000-0000-0000-0000-00000000aaaa";

function workspaceRow(team_id: string | null) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    builder[m] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => ({
    data: team_id ? { team_id, is_primary: true, connected_at: "2026-01-01" } : null,
    error: null,
  }));
  return { from: vi.fn(() => builder) };
}

function okFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, channel: "C1" }), { status: 200 }),
  );
}

describe("slackFetch dual-read — per-workspace key + bare-key fallback (Slice 1)", () => {
  beforeEach(() => {
    mockedGetSecret.mockReset();
    mockedServiceClient.mockReset();
    vi.stubGlobal("fetch", okFetch());
  });

  it("with an explicit team_id, reads the keyed secret slack.bot_token:<team_id>", async () => {
    mockedServiceClient.mockReturnValue(workspaceRow("TKEYED"));
    mockedGetSecret.mockImplementation(async (_t: string, key: string) =>
      key === "slack.bot_token:TKEYED" ? "xoxb-keyed" : null,
    );

    await slackFetch(TENANT, "chat.postMessage", { channel: "C1" }, "TKEYED");

    expect(mockedGetSecret).toHaveBeenCalledWith(TENANT, "slack.bot_token:TKEYED");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer xoxb-keyed",
    });
  });

  it("falls back to the BARE key when only the legacy secret is present (pre-rotate)", async () => {
    mockedServiceClient.mockReturnValue(workspaceRow("TBARE"));
    mockedGetSecret.mockImplementation(async (_t: string, key: string) =>
      key === "slack.bot_token" ? "xoxb-bare-legacy" : null,
    );

    await slackFetch(TENANT, "chat.postMessage", { channel: "C1" }, "TBARE");

    expect(mockedGetSecret).toHaveBeenCalledWith(TENANT, "slack.bot_token:TBARE");
    expect(mockedGetSecret).toHaveBeenCalledWith(TENANT, "slack.bot_token");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer xoxb-bare-legacy",
    });
  });

  it("without a team_id arg, resolves the primary workspace team_id then the keyed secret", async () => {
    mockedServiceClient.mockReturnValue(workspaceRow("TPRIMARY"));
    mockedGetSecret.mockImplementation(async (_t: string, key: string) =>
      key === "slack.bot_token:TPRIMARY" ? "xoxb-primary" : null,
    );

    await slackFetch(TENANT, "chat.postMessage", { channel: "C1" });

    expect(mockedServiceClient).toHaveBeenCalled();
    expect(mockedGetSecret).toHaveBeenCalledWith(TENANT, "slack.bot_token:TPRIMARY");
  });

  it("throws slack_not_connected when neither keyed nor bare secret exists", async () => {
    mockedServiceClient.mockReturnValue(workspaceRow("TGONE"));
    mockedGetSecret.mockResolvedValue(null);

    await expect(
      slackFetch(TENANT, "chat.postMessage", { channel: "C1" }, "TGONE"),
    ).rejects.toBeInstanceOf(ExpectedToolError);
  });

  it("with no workspace row AND no team_id, still tries the bare key (oldest-fallback safety)", async () => {
    mockedServiceClient.mockReturnValue(workspaceRow(null));
    mockedGetSecret.mockImplementation(async (_t: string, key: string) =>
      key === "slack.bot_token" ? "xoxb-bare-only" : null,
    );

    await slackFetch(TENANT, "chat.postMessage", { channel: "C1" });

    expect(mockedGetSecret).toHaveBeenCalledWith(TENANT, "slack.bot_token");
  });
});
