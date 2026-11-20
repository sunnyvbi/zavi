// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => `https://api.zaviagent.com${p}`,
}));

import { useProductUrl, __resetProductUrlCache } from "./useProductUrl";

function Probe() {
  const productUrl = useProductUrl();
  return <span data-testid="url">{productUrl?.marketing ?? "none"}</span>;
}

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  __resetProductUrlCache();
  apiFetch.mockReset();
});
afterEach(() => cleanup());

describe("useProductUrl", () => {
  it("re-renders the consumer with the URL once the GET resolves", async () => {
    apiFetch.mockResolvedValue(
      okJson({ product_url: { marketing: "https://latest.upcar.ai/" } }),
    );
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("url").textContent).toBe("https://latest.upcar.ai/"),
    );
    expect(apiFetch).toHaveBeenCalledWith("/api/connectors/product-url");
  });

  it("costs ONE GET no matter how many consumers mount", async () => {
    apiFetch.mockResolvedValue(
      okJson({ product_url: { marketing: "https://x.com" } }),
    );
    render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("url")[0].textContent).toBe("https://x.com"),
    );
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("degrades to 'no url on file' when the GET fails — never blocks the pane", async () => {
    apiFetch.mockRejectedValue(new Error("network down"));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("url").textContent).toBe("none"));
  });

  it("degrades to 'no url on file' on a non-2xx", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("url").textContent).toBe("none"));
  });

  it("reports no url when the tenant has none registered", async () => {
    apiFetch.mockResolvedValue(okJson({ product_url: {} }));
    render(<Probe />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("url").textContent).toBe("none");
  });
});
