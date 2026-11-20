
import { describe, it, expect } from "vitest";
import { isConnectorWallChatDegradeEnabled } from "../_chat-degrade-flag-check";

function sbWith(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return { from: () => chain } as never;
}

describe("isConnectorWallChatDegradeEnabled (default ON)", () => {
  it("true when blob.connector_wall_chat_degrade_enabled === true", async () => {
    expect(
      await isConnectorWallChatDegradeEnabled(
        sbWith({
          data: { blob: { connector_wall_chat_degrade_enabled: true } },
          error: null,
        }),
      ),
    ).toBe(true);
  });

  it("true when the flag is ABSENT (default ON)", async () => {
    expect(
      await isConnectorWallChatDegradeEnabled(
        sbWith({ data: { blob: {} }, error: null }),
      ),
    ).toBe(true);
  });

  it("true when there is no system_config row at all (default ON)", async () => {
    expect(
      await isConnectorWallChatDegradeEnabled(
        sbWith({ data: null, error: null }),
      ),
    ).toBe(true);
  });

  it("FALSE only when the flag is EXPLICITLY false (the kill switch)", async () => {
    expect(
      await isConnectorWallChatDegradeEnabled(
        sbWith({
          data: { blob: { connector_wall_chat_degrade_enabled: false } },
          error: null,
        }),
      ),
    ).toBe(false);
  });

  it("true for any non-false value (a 'false' STRING is not the boolean kill switch)", async () => {
    expect(
      await isConnectorWallChatDegradeEnabled(
        sbWith({
          data: { blob: { connector_wall_chat_degrade_enabled: "false" } },
          error: null,
        }),
      ),
    ).toBe(true);
  });

  it("SOFT-FAILS to false (the wall) on a read error — kill switch stays authoritative when unreadable", async () => {
    expect(
      await isConnectorWallChatDegradeEnabled(
        sbWith({ data: null, error: { message: "boom" } }),
      ),
    ).toBe(false);
  });

  it("SOFT-FAILS to false (the wall) when the client throws", async () => {
    const throwingSb = {
      from: () => {
        throw new Error("network down");
      },
    } as never;
    expect(await isConnectorWallChatDegradeEnabled(throwingSb)).toBe(false);
  });
});
