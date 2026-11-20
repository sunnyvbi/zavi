import { describe, it, expect, vi, beforeEach } from "vitest";

const slackFetch = vi.fn();
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: (...args: unknown[]) => slackFetch(...args),
}));

import { ensureDigestChannel, DIGEST_CHANNEL_NAME } from "../slack-ensure-digest-channel";
import { ExpectedToolError } from "@/services/tools/types";

const T = "tenant-1";
const TEAM = "T123";
const INSTALLER = "U_INSTALLER";

function slackErr(code: string) {
  return new ExpectedToolError("slack_api_error", `not ok: ${code}`, { slack_error: code });
}
function methodOf(call: unknown[]): string {
  return call[1] as string;
}

beforeEach(() => slackFetch.mockReset());

describe("ensureDigestChannel — the canonical name", () => {
  it("creates and invites into #zavi-updates, not the legacy alias", () => {
    expect(DIGEST_CHANNEL_NAME).toBe("zavi-updates");
  });
});

describe("ensureDigestChannel — fresh workspace (channel absent)", () => {
  it("creates the channel then invites the installer", async () => {
    slackFetch
      .mockResolvedValueOnce({ channels: [{ id: "C_GEN", name: "general" }] })
      .mockResolvedValueOnce({ channel: { id: "C_NEW" } })
      .mockResolvedValueOnce({ ok: true });

    const out = await ensureDigestChannel(T, TEAM, INSTALLER);

    expect(out).toBe("created");
    const methods = slackFetch.mock.calls.map(methodOf);
    expect(methods).toEqual(["conversations.list", "conversations.create", "conversations.invite"]);
    expect(slackFetch.mock.calls[1][2]).toMatchObject({ name: "zavi-updates", is_private: false });
    expect(slackFetch.mock.calls[2][2]).toMatchObject({ channel: "C_NEW", users: INSTALLER });
  });

  it("still creates when there is no installer id, and skips the invite", async () => {
    slackFetch
      .mockResolvedValueOnce({ channels: [] })
      .mockResolvedValueOnce({ channel: { id: "C_NEW" } });

    const out = await ensureDigestChannel(T, TEAM, null);

    expect(out).toBe("created");
    expect(slackFetch.mock.calls.map(methodOf)).toEqual([
      "conversations.list",
      "conversations.create",
    ]);
  });
});

describe("ensureDigestChannel — idempotent by existence", () => {
  it("does NOT create a second channel when #zavi-updates already exists", async () => {
    slackFetch
      .mockResolvedValueOnce({
        channels: [
          { id: "C_FB", name: "zavi-feedback" },
          { id: "C_UPD", name: "zavi-updates" },
        ],
      })
      .mockResolvedValueOnce({ ok: true });

    const out = await ensureDigestChannel(T, TEAM, INSTALLER);

    expect(out).toBe("already_exists");
    const methods = slackFetch.mock.calls.map(methodOf);
    expect(methods).toContain("conversations.invite");
    expect(methods).not.toContain("conversations.create");
    expect(slackFetch.mock.calls[1][2]).toMatchObject({ channel: "C_UPD", users: INSTALLER });
  });

  it("treats a create race (name_taken) as already-exists and invites", async () => {
    slackFetch
      .mockResolvedValueOnce({ channels: [] })
      .mockRejectedValueOnce(slackErr("name_taken"))
      .mockResolvedValueOnce({ channels: [{ id: "C_RACE", name: "zavi-updates" }] })
      .mockResolvedValueOnce({ ok: true });

    const out = await ensureDigestChannel(T, TEAM, INSTALLER);

    expect(out).toBe("already_exists");
    expect(slackFetch.mock.calls[3][2]).toMatchObject({ channel: "C_RACE", users: INSTALLER });
  });
});

describe("ensureDigestChannel — the expected rollout state (no reconnect yet)", () => {
  it("no-ops on missing_scope from list (existing tenant, pre-reconnect)", async () => {
    slackFetch.mockRejectedValueOnce(slackErr("missing_scope"));
    const out = await ensureDigestChannel(T, TEAM, INSTALLER);
    expect(out).toBe("missing_scope");
    expect(slackFetch).toHaveBeenCalledTimes(1);
  });

  it("no-ops on missing_scope from create", async () => {
    slackFetch
      .mockResolvedValueOnce({ channels: [] })
      .mockRejectedValueOnce(slackErr("missing_scope"));
    const out = await ensureDigestChannel(T, TEAM, INSTALLER);
    expect(out).toBe("missing_scope");
  });

  it("reports slack_not_connected on an auth error", async () => {
    slackFetch.mockRejectedValueOnce(slackErr("invalid_auth"));
    expect(await ensureDigestChannel(T, TEAM, INSTALLER)).toBe("slack_not_connected");
  });
});

describe("ensureDigestChannel — never throws out", () => {
  it("swallows a transient list error and reports error (no blind create)", async () => {
    slackFetch.mockRejectedValueOnce(new Error("network blip"));
    const out = await ensureDigestChannel(T, TEAM, INSTALLER);
    expect(out).toBe("error");
    expect(slackFetch).toHaveBeenCalledTimes(1);
  });

  it("still succeeds (created) when the invite itself fails", async () => {
    slackFetch
      .mockResolvedValueOnce({ channels: [] })
      .mockResolvedValueOnce({ channel: { id: "C_NEW" } })
      .mockRejectedValueOnce(slackErr("already_in_channel"));
    const out = await ensureDigestChannel(T, TEAM, INSTALLER);
    expect(out).toBe("created");
  });
});
