// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let lockedTier: string | null = "pro";
let role: string | null = "owner";
const apiFetch = vi.fn();
const track = vi.hoisted(() => vi.fn());

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({ role, tenantId: "tenant-1", treeAgents: [{ slug: "engineer", locked_tier: lockedTier }] }),
}));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: track }));
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/marketing/pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketing/pricing")>();
  return { ...actual, fetchLivePricingClient: async () => actual.PRICING_FALLBACK };
});

import { ProPlanGate } from "./ProPlanGate";

const page = () =>
  render(
    <ProPlanGate slug="engineer" feature="Engineer">
      <textarea aria-label="composer" />
    </ProPlanGate>,
  );

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

let location: { href: string };

beforeEach(() => {
  lockedTier = "pro";
  role = "owner";
  apiFetch.mockReset();
  track.mockClear();
  location = { href: "" };
  vi.stubGlobal("location", location);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("locked by the backend: covers the page with the upgrade notice and makes it inert", () => {
  const view = page();
  const cta = view.getByRole("button", { name: /is a Pro feature/ });
  expect(cta).toBeTruthy();
  expect(cta.textContent).toContain("$240 a month");
  expect(cta.textContent).toContain("Upgrade to Pro");
  expect(cta.textContent).not.toContain("the $240 plan");
  const composer = view.container.querySelector("textarea")!;
  expect(composer.closest("[inert]")).not.toBeNull();
  expect(composer.closest("[aria-hidden='true']")).not.toBeNull();
});

it("clicking the notice starts Pro checkout and leaves for Stripe", async () => {
  apiFetch.mockResolvedValue(json(200, { url: "https://checkout.stripe.test/s" }));
  const view = page();
  fireEvent.click(view.getByRole("button", { name: /upgrade/i }));
  await waitFor(() => expect(location.href).toBe("https://checkout.stripe.test/s"));
  const [path, init] = apiFetch.mock.calls[0]!;
  expect(path).toBe("/api/billing/checkout");
  expect(JSON.parse((init as RequestInit).body as string)).toEqual({ tier: "pro", origin: "workspace" });
  expect(track.mock.calls).toEqual([
    ["pricing_plan_selected", { tier: "pro", term: "monthly", location: "paywall", tenant_id: "tenant-1" }],
  ]);
});

it("follows the Portal redirect for a workspace that already subscribes", async () => {
  apiFetch.mockResolvedValue(json(200, { redirect: "https://billing.stripe.test/p" }));
  const view = page();
  fireEvent.click(view.getByRole("button", { name: /upgrade/i }));
  await waitFor(() => expect(location.href).toBe("https://billing.stripe.test/p"));
});

it("says so when billing is not configured, instead of a dead click", async () => {
  apiFetch.mockResolvedValue(json(503, { error: { code: "billing_not_configured" } }));
  const view = page();
  fireEvent.click(view.getByRole("button", { name: /upgrade/i }));
  expect((await view.findByRole("alert")).textContent).toMatch(/isn't available yet/);
  expect(location.href).toBe("");
});

it("a member sees the wall but no checkout button", () => {
  role = "member";
  const view = page();
  expect(view.queryByRole("button")).toBeNull();
  expect(view.getByText(/Ask a workspace owner or admin/)).toBeTruthy();
});

it("unlocked by the backend: no notice, and the page is interactive", () => {
  lockedTier = null;
  const view = page();
  expect(view.queryByText(/You need to upgrade/)).toBeNull();
  expect(view.container.querySelector("[inert]")).toBeNull();
  expect(view.getByRole("textbox", { name: "composer" })).toBeTruthy();
});

it("a lockedTier prop names that plan and starts its checkout (an Analytics tab)", async () => {
  apiFetch.mockResolvedValue(json(200, { url: "https://checkout.stripe.test/s" }));
  const view = render(
    <ProPlanGate lockedTier="starter" feature="SEO analytics">
      <div />
    </ProPlanGate>,
  );
  const cta = view.getByRole("button", { name: /SEO analytics is a Starter feature/ });
  expect(cta.textContent).toContain("Upgrade to Starter");
  fireEvent.click(cta);
  await waitFor(() => expect(location.href).toBe("https://checkout.stripe.test/s"));
  expect(JSON.parse((apiFetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
    tier: "starter",
    origin: "workspace",
  });
});
