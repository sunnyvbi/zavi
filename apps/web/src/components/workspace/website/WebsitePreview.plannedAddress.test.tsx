// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NOT_LIVE_YET, WebsitePreview } from "./WebsitePreview";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }) }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

afterEach(cleanup);

const progress = <div>Building your site</div>;

describe("DEL-1323 B25: the address bar before anything is live", () => {
  it("names the site's planned address and says it is not live yet, with no grey placeholder", () => {
    render(<WebsitePreview liveUrl={null} body={progress} notLiveAddress={{ host: "paws.zaviagent.com" }} />);
    const bar = screen.getByTestId("preview-address-planned");
    expect(bar.textContent).toBe(`paws.zaviagent.com· ${NOT_LIVE_YET}`);
    expect(screen.queryByTestId("preview-address-pending")).toBeNull();
    expect(bar.querySelector(".animate-pulse")).toBeNull();
  });

  it("says Not live yet when no address is planned", () => {
    render(<WebsitePreview liveUrl={null} body={progress} notLiveAddress={{ host: null }} />);
    expect(screen.getByTestId("preview-address-planned").textContent).toBe(NOT_LIVE_YET);
  });

  it("publish on request: the top bar shows only the planned address, never Not published or Not live yet, and is not a link", () => {
    const { container } = render(
      <WebsitePreview liveUrl={null} body={progress} notLiveAddress={{ host: "laptophub-b896bdf2-d1.zaviagent.com", label: "Not published" }} />,
    );
    const bar = screen.getByTestId("preview-address-planned");
    expect(bar.textContent).toBe("laptophub-b896bdf2-d1.zaviagent.com");
    expect(bar.querySelector("a")).toBeNull();
    const chrome = container.querySelector("[data-testid='preview-chrome']")!;
    expect(chrome.textContent).not.toMatch(/Not published|Not live yet|·/);
    cleanup();
    const second = render(<WebsitePreview liveUrl={null} body={progress} notLiveAddress={{ host: null, label: "Not published" }} />);
    const emptyChrome = second.container.querySelector("[data-testid='preview-chrome']")!;
    expect(emptyChrome.textContent).not.toMatch(/Not published|Not live yet/);
    expect(screen.queryByTestId("preview-address-planned")).toBeNull();
    expect(screen.queryByTestId("preview-address-pending")).toBeNull();
  });

  it("keeps the old placeholder when the planned address is not passed", () => {
    render(<WebsitePreview liveUrl={null} body={progress} />);
    expect(screen.getByTestId("preview-address-pending").querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByTestId("preview-address-planned")).toBeNull();
  });
});
