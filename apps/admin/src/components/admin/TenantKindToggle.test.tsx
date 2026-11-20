import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi, beforeEach } from "vitest";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-admin", () => ({ adminApiFetch: fetchMock }));
import { TenantKindToggle, setTenantKind } from "./TenantKindToggle";

beforeEach(() => {
  fetchMock.mockReset();
});

it("offers the opposite kind of the current one", () => {
  expect(renderToStaticMarkup(<TenantKindToggle tenantId="t1" initialKind="test" />)).toContain("Mark as real");
  expect(renderToStaticMarkup(<TenantKindToggle tenantId="t1" initialKind={null} />)).toContain("Mark as test");
});

it("only shows other kinds such as an unclaimed launch-video shell", () => {
  const html = renderToStaticMarkup(<TenantKindToggle tenantId="t1" initialKind="launch_video_shell" />);
  expect(html).toContain("launch_video_shell");
  expect(html).not.toContain("Mark as");
});

it("posts the new kind to the staff kind route and returns the saved kind", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ kind: "test" }), { status: 200 }));
  await expect(setTenantKind("t1", "test")).resolves.toBe("test");
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/tenants/t1/kind", expect.objectContaining({ method: "POST", body: JSON.stringify({ kind: "test" }) }));
});

it("surfaces the route's error instead of pretending it saved", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "set_kind_failed" } }), { status: 500 }));
  await expect(setTenantKind("t1", "real")).rejects.toThrow("set_kind_failed");
});
