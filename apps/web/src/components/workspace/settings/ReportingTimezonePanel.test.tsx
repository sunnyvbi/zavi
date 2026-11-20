// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { ReportingTimezonePanel } from "./ReportingTimezonePanel";

const reply = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("ReportingTimezonePanel", () => {
  it("warns and shows UTC when no timezone was found", async () => {
    apiFetch.mockResolvedValue(reply({ reporting_timezone: null, effective: "UTC", source: "default" }));
    const { findByText, container } = render(<ReportingTimezonePanel />);
    expect(await findByText(/No timezone found in your connected tools/)).toBeTruthy();
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("UTC");
  });

  it("says where an auto-detected zone came from", async () => {
    apiFetch.mockResolvedValue(reply({ reporting_timezone: null, effective: "America/Los_Angeles", source: "ga4_property" }));
    const { findByText, queryByText } = render(<ReportingTimezonePanel />);
    expect(await findByText("Auto-detected from Google Analytics: America/Los_Angeles")).toBeTruthy();
    expect(queryByText("Reset to auto")).toBeNull();
  });

  it("saves a chosen zone, then offers Reset to auto, which clears it", async () => {
    apiFetch
      .mockResolvedValueOnce(reply({ reporting_timezone: null, effective: "America/Los_Angeles", source: "ga4_property" }))
      .mockResolvedValueOnce(reply({ reporting_timezone: "America/New_York" }))
      .mockResolvedValueOnce(reply({ reporting_timezone: "America/New_York", effective: "America/New_York", source: "stored" }))
      .mockResolvedValueOnce(reply({ reporting_timezone: null }))
      .mockResolvedValueOnce(reply({ reporting_timezone: null, effective: "America/Los_Angeles", source: "ga4_property" }));
    const { container, findByText, getByText } = render(<ReportingTimezonePanel />);
    await findByText(/Auto-detected/);
    const save = getByText("Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(container.querySelector("select") as HTMLSelectElement, { target: { value: "America/New_York" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await findByText("Saved for this workspace.");
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/tenant/me/reporting-timezone", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ reporting_timezone: "America/New_York" }) }));
    fireEvent.click(getByText("Reset to auto"));
    await findByText(/Auto-detected/);
    expect(apiFetch).toHaveBeenNthCalledWith(4, "/api/tenant/me/reporting-timezone", expect.objectContaining({ body: JSON.stringify({ reporting_timezone: null }) }));
  });

  it("a failed read says so and offers a retry, with no guessed zone", async () => {
    apiFetch.mockResolvedValue(reply({}, false));
    const { findByText, container } = render(<ReportingTimezonePanel />);
    expect(await findByText("The reporting timezone could not be loaded.")).toBeTruthy();
    expect(container.querySelector("select")).toBeNull();
    await waitFor(() => expect(within(container).getByText("Try again")).toBeTruthy());
  });
});
