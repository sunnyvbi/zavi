// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { SiteFunctionsSettings, type SiteFunctionsPayload } from "./SiteFunctionsSettings";

const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const VALUE = ["sk", "test", "51NabcdefGHIJKLmnopQRSTuv"].join("_");

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const payload = (): SiteFunctionsPayload => ({
  secrets: { secrets: [{ name: "STRIPE_SECRET_KEY", updated_at: "2026-10-02T00:00:00Z" }], required: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] },
  functions: [
    { name: "create-checkout", kind: "http", url: "https://shop.example.com/api/fn/create-checkout", cron: null, enabled: null, last_run: null },
    { name: "stripe-webhook", kind: "webhook", url: "https://shop.example.com/api/hooks/stripe-webhook", cron: null, enabled: null, last_run: { id: "r1", started_at: "2026-10-02T01:00:00Z", duration_ms: 40, status: "error", http_status: 401 } },
    { name: "nightly", kind: "schedule", url: null, cron: "0 3 * * *", enabled: true, last_run: null },
  ],
});

let data: SiteFunctionsPayload;
beforeEach(() => {
  data = payload();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/website/site-functions?")) return json(200, data);
    if (url.startsWith("/api/website/site-secrets/") && init?.method === "PUT") {
      const name = decodeURIComponent(url.split("/").pop()!.split("?")[0]);
      data.secrets.secrets.push({ name, updated_at: "2026-10-02T02:00:00Z" });
      return json(200, { secret: { name, updated_at: "2026-10-02T02:00:00Z" } });
    }
    if (url.startsWith("/api/website/site-secrets/") && init?.method === "DELETE") return json(200, { deleted: true });
    if (url.includes("/runs?")) return json(200, { runs: [{ id: "r1", started_at: "2026-10-02T01:00:00Z", duration_ms: 40, status: "error", http_status: 401, log: [{ at: "2026-10-02T01:00:00Z", level: "error", message: "Stripe signature check failed" }] }] });
    if (url.startsWith("/api/website/site-schedules/")) {
      const body = JSON.parse(String(init?.body));
      data.functions[2].enabled = body.enabled;
      return json(200, { function: data.functions[2] });
    }
    return json(404, {});
  });
});
afterEach(cleanup);

describe("Secrets", () => {
  it("lists names only and calls out the missing one", async () => {
    const { container } = render(<SiteFunctionsSettings buildSessionId={BUILD} section="secrets" />);
    await screen.findByText("STRIPE_SECRET_KEY");
    expect(screen.getByText(/needs this secret/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add STRIPE_WEBHOOK_SECRET/ })).toBeTruthy();
    expect(container.innerHTML).not.toContain("sk_test");
  });

  it("sends the value once, never shows it, and empties the field", async () => {
    const { container } = render(<SiteFunctionsSettings buildSessionId={BUILD} section="secrets" />);
    fireEvent.click(await screen.findByRole("button", { name: /Add STRIPE_WEBHOOK_SECRET/ }));
    const form = screen.getByRole("form", { name: "Add a secret" });
    const valueInput = form.querySelector("input[data-secret-input]") as HTMLInputElement;
    expect(valueInput.type).toBe("password");
    fireEvent.change(valueInput, { target: { value: VALUE } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/website/site-secrets/STRIPE_WEBHOOK_SECRET", expect.objectContaining({ method: "PUT" })));
    const put = apiFetch.mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(JSON.parse(put[1].body)).toEqual({ build_session_id: BUILD, value: VALUE });
    await screen.findByText("STRIPE_WEBHOOK_SECRET");
    expect(container.textContent).not.toContain(VALUE);
    for (const input of Array.from(container.querySelectorAll("input"))) expect(input.value).not.toBe(VALUE);
  });

  it("a failed save empties the field and shows the reason", async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/website/site-functions?")) return json(200, data);
      if (init?.method === "PUT") return json(503, { error: { code: "functions_unavailable", message: "x" } });
      return json(404, {});
    });
    const { container } = render(<SiteFunctionsSettings buildSessionId={BUILD} section="secrets" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a secret" }));
    const form = screen.getByRole("form", { name: "Add a secret" });
    fireEvent.change(form.querySelector("input:not([data-secret-input])")!, { target: { value: "my_key" } });
    const valueInput = form.querySelector("input[data-secret-input]") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: VALUE } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await screen.findByText(/aren't available yet/);
    expect(valueInput.value).toBe("");
    expect(container.textContent).not.toContain(VALUE);
    expect(apiFetch.mock.calls.some((c) => String(c[0]).endsWith("/MY_KEY"))).toBe(true);
  });

  it("replace locks the name; delete asks first", async () => {
    render(<SiteFunctionsSettings buildSessionId={BUILD} section="secrets" />);
    await screen.findByText("STRIPE_SECRET_KEY");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    const form = screen.getByRole("form", { name: "Replace STRIPE_SECRET_KEY" });
    expect((form.querySelector("input:not([data-secret-input])") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/will stop working/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(`/api/website/site-secrets/STRIPE_SECRET_KEY?build_session_id=${BUILD}`, { method: "DELETE" }),
    );
  });

  it("a plain member sees why, not a broken page", async () => {
    apiFetch.mockImplementation(async () => json(403, { error: { code: "forbidden" } }));
    render(<SiteFunctionsSettings buildSessionId={BUILD} section="secrets" />);
    await screen.findByText(/Only workspace owners and admins/);
  });
});

describe("Functions and Schedules", () => {
  it("shows each function, the webhook address, and runs on demand", async () => {
    render(<SiteFunctionsSettings buildSessionId={BUILD} section="functions" />);
    await screen.findByText("stripe-webhook");
    expect(screen.getByText("https://shop.example.com/api/hooks/stripe-webhook")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Runs and logs" });
    fireEvent.click(buttons[1]);
    await screen.findByText(/Stripe signature check failed/);
    expect(apiFetch).toHaveBeenCalledWith(`/api/website/site-functions/stripe-webhook/runs?build_session_id=${BUILD}&limit=20`, { signal: expect.any(AbortSignal) });
  });

  it("toggles a schedule off", async () => {
    render(<SiteFunctionsSettings buildSessionId={BUILD} section="schedules" />);
    const sw = await screen.findByRole("switch", { name: "Pause nightly" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await screen.findByRole("switch", { name: "Resume nightly" });
    const post = apiFetch.mock.calls.find((c) => String(c[0]).startsWith("/api/website/site-schedules/"))!;
    expect(JSON.parse(post[1].body)).toEqual({ build_session_id: BUILD, enabled: false });
  });
});
