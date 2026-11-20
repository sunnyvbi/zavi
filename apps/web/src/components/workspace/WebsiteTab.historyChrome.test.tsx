// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
const toastAdd = vi.fn();
vi.mock("@/components/ui/toast", () => ({ toast: { add: (...a: unknown[]) => toastAdd(...a) } }));

import { WebsitePreview } from "./website/WebsitePreview";

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  toastAdd.mockReset();
});

describe("WebsitePreview chromeOverride", () => {
  it("replaces the standard preview chrome with the history bar while a version is framed", () => {
    render(
      <WebsitePreview
        liveUrl="https://acme.zaviagent.com"
        cacheKey={null}
        appId={null}
        builtApp={false}
        chromeOverride={<div data-testid="history-chrome">Back to latest</div>}
      />,
    );
    expect(screen.getByTestId("history-chrome")).toBeTruthy();
    expect(screen.queryByTestId("preview-chrome")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  it("shows the standard chrome when nothing overrides it", () => {
    render(<WebsitePreview liveUrl="https://acme.zaviagent.com" cacheKey={null} appId={null} builtApp={false} />);
    expect(screen.getByTestId("preview-chrome")).toBeTruthy();
  });
});
