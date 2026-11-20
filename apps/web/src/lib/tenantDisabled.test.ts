// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { noticeTenantDisabled, TENANT_DISABLED_EVENT } from "./tenantDisabled";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("noticeTenantDisabled", () => {
  const seen = vi.fn();
  afterEach(() => {
    window.removeEventListener(TENANT_DISABLED_EVENT, seen);
    seen.mockReset();
  });

  it("fires the event on a 403 tenant_disabled and leaves the body readable", async () => {
    window.addEventListener(TENANT_DISABLED_EVENT, seen);
    const res = json(403, { error: { code: "tenant_disabled", message: "x" } });
    expect(await noticeTenantDisabled(res)).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect((await res.json()).error.code).toBe("tenant_disabled");
  });

  it("ignores other 403s and other statuses", async () => {
    window.addEventListener(TENANT_DISABLED_EVENT, seen);
    expect(await noticeTenantDisabled(json(403, { error: { code: "membership_revoked" } }))).toBe(false);
    expect(await noticeTenantDisabled(json(500, { error: { code: "tenant_disabled" } }))).toBe(false);
    expect(await noticeTenantDisabled(new Response("not json", { status: 403 }))).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });
});
