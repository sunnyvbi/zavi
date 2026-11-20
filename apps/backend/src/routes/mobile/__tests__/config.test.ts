
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  enabled: true as boolean,
  billing: true as boolean,
  iosLive: false as boolean,
  throws: false as boolean,
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (key: string) => {
    if (H.throws) throw new Error("config store down");
    if (key === "ios_app_store_live") return H.iosLive;
    return key === "mobile_ios_billing_enabled" ? H.billing : H.enabled;
  }),
}));

import { getMobileConfig } from "../config";
import { getBoolSetting } from "@/services/settings";

function makeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

const run = async () => {
  const res = makeRes();
  await getMobileConfig({} as never, res as never);
  return res;
};

describe("GET /api/mobile/config", () => {
  beforeEach(() => {
    H.enabled = true;
    H.billing = true;
    H.iosLive = false;
    H.throws = false;
    vi.clearAllMocks();
  });

  it("returns 200 with both flags ON by default", async () => {
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ isSignupEnabled: true, isIosBillingEnabled: true, isIosAppStoreLive: false });
  });

  it("reports iOS billing OFF when mobile_ios_billing_enabled is flipped off", async () => {
    H.billing = false;
    const res = await run();
    expect(res.body).toEqual({ isSignupEnabled: true, isIosBillingEnabled: false, isIosAppStoreLive: false });
    expect(getBoolSetting).toHaveBeenCalledWith("mobile_ios_billing_enabled");
  });

  it("reports the iOS app live when ios_app_store_live is flipped on", async () => {
    H.iosLive = true;
    const res = await run();
    expect(res.body).toEqual({ isSignupEnabled: true, isIosBillingEnabled: true, isIosAppStoreLive: true });
    expect(getBoolSetting).toHaveBeenCalledWith("ios_app_store_live");
  });

  it("reports signup OFF when the flag is flipped off", async () => {
    H.enabled = false;
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ isSignupEnabled: false, isIosBillingEnabled: true, isIosAppStoreLive: false });
  });

  it("reads the GLOBAL mobile_signup_enabled key with no tenant", async () => {
    await run();
    expect(getBoolSetting).toHaveBeenCalledWith("mobile_signup_enabled");
  });

  it("FAILS OPEN with 200 when the settings store throws", async () => {
    H.throws = true;
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ isSignupEnabled: true, isIosBillingEnabled: true, isIosAppStoreLive: false });
  });

  it("sets Cache-Control: no-store so no hop can pin a stale kill switch", async () => {
    const res = await run();
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("never requires auth — resolves with an empty request object", async () => {
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("isSignupEnabled");
  });
});
