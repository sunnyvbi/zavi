import { describe, it, expect, vi, beforeEach } from "vitest";

const reply: { data: unknown; error: unknown; throws: boolean } = { data: null, error: null, throws: false };
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({
    from: (t: string) => {
      if (t !== "system_config") throw new Error(`unexpected table ${t}`);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (reply.throws) throw new Error("down");
          return { data: reply.data, error: reply.error };
        },
      };
      return chain;
    },
  }),
}));

import {
  EXTENSION_BROWSER_CONTROL_FLAG_KEY,
  isExtensionBrowserControlEnabled,
} from "@/services/extension/control-flag";

beforeEach(() => {
  Object.assign(reply, { data: null, error: null, throws: false });
});

describe("isExtensionBrowserControlEnabled", () => {
  it("is ON when the key is absent (default ON since S3)", async () => {
    reply.data = { blob: {} };
    expect(await isExtensionBrowserControlEnabled()).toBe(true);
    reply.data = { blob: null };
    expect(await isExtensionBrowserControlEnabled()).toBe(true);
  });

  it("only an explicit boolean false turns it off (the kill switch)", async () => {
    reply.data = { blob: { [EXTENSION_BROWSER_CONTROL_FLAG_KEY]: false } };
    expect(await isExtensionBrowserControlEnabled()).toBe(false);
    reply.data = { blob: { [EXTENSION_BROWSER_CONTROL_FLAG_KEY]: true } };
    expect(await isExtensionBrowserControlEnabled()).toBe(true);
    reply.data = { blob: { [EXTENSION_BROWSER_CONTROL_FLAG_KEY]: "false" } };
    expect(await isExtensionBrowserControlEnabled()).toBe(true);
  });

  it("fails CLOSED on a read error, a thrown error, or no row", async () => {
    reply.error = { message: "boom" };
    reply.data = { blob: { [EXTENSION_BROWSER_CONTROL_FLAG_KEY]: true } };
    expect(await isExtensionBrowserControlEnabled()).toBe(false);
    Object.assign(reply, { error: null, throws: true });
    expect(await isExtensionBrowserControlEnabled()).toBe(false);
    Object.assign(reply, { throws: false, data: null });
    expect(await isExtensionBrowserControlEnabled()).toBe(false);
  });
});
