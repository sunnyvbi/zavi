
import { describe, it, expect } from "vitest";
import { isRenderLaunchVideoEnabled } from "../_render-launch-video-flag-check";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function sbWith(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return { from: () => chain } as never;
}

describe("isRenderLaunchVideoEnabled", () => {
  it("true when enabled AND tenant is in the allowlist", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({
          data: { blob: { render_launch_video_enabled: true, render_launch_video_tenants: [TENANT] } },
          error: null,
        }),
      ),
    ).toBe(true);
  });

  it("true for ANY tenant when all-tenants mode is on (no allowlist needed)", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        "some-random-tenant-not-in-any-list",
        sbWith({
          data: { blob: { render_launch_video_enabled: true, render_launch_video_all: true } },
          error: null,
        }),
      ),
    ).toBe(true);
  });

  it("false in all-tenants mode when the master switch is off", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({
          data: { blob: { render_launch_video_enabled: false, render_launch_video_all: true } },
          error: null,
        }),
      ),
    ).toBe(false);
  });

  it("false when enabled but tenant NOT in the allowlist", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({
          data: { blob: { render_launch_video_enabled: true, render_launch_video_tenants: ["other-tenant"] } },
          error: null,
        }),
      ),
    ).toBe(false);
  });

  it("false when tenant is allowlisted but master switch is off", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({
          data: { blob: { render_launch_video_enabled: false, render_launch_video_tenants: [TENANT] } },
          error: null,
        }),
      ),
    ).toBe(false);
  });

  it("false when blob keys are absent (default OFF)", async () => {
    expect(await isRenderLaunchVideoEnabled(TENANT, sbWith({ data: { blob: {} }, error: null }))).toBe(false);
  });

  it("false for a non-boolean 'true' string — strict === true only", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({
          data: { blob: { render_launch_video_enabled: "true", render_launch_video_tenants: [TENANT] } },
          error: null,
        }),
      ),
    ).toBe(false);
  });

  it("false on empty tenant_id", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        "",
        sbWith({ data: { blob: { render_launch_video_enabled: true, render_launch_video_tenants: [""] } }, error: null }),
      ),
    ).toBe(false);
  });

  it("SOFT-FAILS to false on a read error", async () => {
    expect(await isRenderLaunchVideoEnabled(TENANT, sbWith({ data: null, error: { message: "boom" } }))).toBe(false);
  });

  it("SOFT-FAILS to false when the client throws", async () => {
    const throwingSb = {
      from: () => {
        throw new Error("network down");
      },
    } as never;
    expect(await isRenderLaunchVideoEnabled(TENANT, throwingSb)).toBe(false);
  });

  it("LIVE prod shape — render_launch_video_enabled + render_launch_video_all still resolves enabled", () => {
    return isRenderLaunchVideoEnabled(
      "any-tenant",
      sbWith({ data: { blob: { render_launch_video_enabled: true, render_launch_video_all: true } }, error: null }),
    ).then((v) => expect(v).toBe(true));
  });

  it("NEW alias — render_video_enabled + render_video_all resolves enabled for any tenant", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        "some-random-tenant",
        sbWith({ data: { blob: { render_video_enabled: true, render_video_all: true } }, error: null }),
      ),
    ).toBe(true);
  });

  it("MIXED — legacy master switch + new all-tenants alias resolves enabled", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        "some-random-tenant",
        sbWith({ data: { blob: { render_launch_video_enabled: true, render_video_all: true } }, error: null }),
      ),
    ).toBe(true);
  });

  it("MIXED — new master switch + legacy all-tenants alias resolves enabled", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({ data: { blob: { render_video_enabled: true, render_launch_video_all: true } }, error: null }),
      ),
    ).toBe(true);
  });

  it("alias allowlist — render_video_tenants is honored", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({ data: { blob: { render_video_enabled: true, render_video_tenants: [TENANT] } }, error: null }),
      ),
    ).toBe(true);
  });

  it("union allowlist — tenant in the legacy list with the alias master switch on", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({ data: { blob: { render_video_enabled: true, render_launch_video_tenants: [TENANT] } }, error: null }),
      ),
    ).toBe(true);
  });

  it("alias master switch OFF → false even with an alias allowlist", async () => {
    expect(
      await isRenderLaunchVideoEnabled(
        TENANT,
        sbWith({ data: { blob: { render_video_enabled: false, render_video_tenants: [TENANT] } }, error: null }),
      ),
    ).toBe(false);
  });
});
