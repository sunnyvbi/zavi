// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LinkedInReadStatus } from "./LinkedInReadStatus";
import { CHANNEL_TAB_EVENT } from "../actions/topActions/api";
afterEach(cleanup);
it("explains stale company metrics, unavailable publishing and the next action", () => {
 render(<LinkedInReadStatus payload={{ page_url: "https://www.linkedin.com/company/example/", freshness: { last_success_day: "2026-11-02", stale: true }, publishing_connected: false, refresh: { remaining: 0, cap: 3 } }} />);
 expect(screen.getByTestId("linkedin-freshness").textContent).toContain("2 Nov 2026 · Out of date");
 expect(screen.getByText(/Publishing profile not connected/)).toBeTruthy();
 expect(screen.getByText(/0 of 3 refreshes/)).toBeTruthy();
 const fn = vi.fn(); window.addEventListener(CHANNEL_TAB_EVENT, fn);
 fireEvent.click(screen.getByRole("button", { name: /Review page/ }));
 expect(fn.mock.calls[0][0].detail).toEqual({ slug: "linkedin_organic", tab: "settings" });
 window.removeEventListener(CHANNEL_TAB_EVENT, fn);
});
it("does not turn unknown connection or unknown metrics into disconnected or zero", () => {
 render(<LinkedInReadStatus payload={{page_url: null, publishing_connected: null}}/>);
 expect(screen.getByText("The publishing connection could not be confirmed.")).toBeTruthy();
 expect(screen.getByText("No successful read saved yet.")).toBeTruthy();
});
it("identifies the publisher separately from the reference page", () => {
 render(<LinkedInReadStatus payload={{page_url: "https://www.linkedin.com/company/example/", publishing_connected: true, publishing_account: { name: "Example Founder" }}}/>);
 expect(screen.getByText("Publishing profile: Example Founder.")).toBeTruthy();
});

it("does not call an unreadable allowance exhausted, and dates the last failed attempt", () => {
 render(<LinkedInReadStatus payload={{page_url:"https://www.linkedin.com/company/example/",refresh:{available:false,remaining:0,cap:3,last_attempt:{at:"2026-11-18T08:00:00Z",ok:false,message:"Read failed"}}}}/>);
 expect(screen.getByText("Refresh allowance unavailable.")).toBeTruthy();
 expect(screen.queryByText(/0 of 3/)).toBeNull();
 expect(screen.getByText(/Last refresh attempt/).textContent).toContain("unsuccessful");
});
