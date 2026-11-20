// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({
  useAppReadiness: () => ({ state: "ready", retry: () => {} }),
}));

import { WebsitePreview, pathFromUrl, previewUrlAtPath, resolveNav } from "./WebsitePreview";

const APP_URL = "https://spoke.zaviagent.com";
const PROXY_ROOT = "https://api.zavi.test/api/workspace/engineer-preview/run-7/";
const PROXY = `${PROXY_ROOT}?__pt=tok.en`;

type OpenPath = { path: string; nonce: string } | null;

function ui(openPath: OpenPath, liveUrl = APP_URL) {
  return <WebsitePreview liveUrl={liveUrl} cacheKey={null} appId="spoke.zaviagent.com" builtApp openPath={openPath} />;
}

function frameSrc(container: HTMLElement): string {
  return (container.querySelector("iframe") as HTMLIFrameElement).getAttribute("src") ?? "";
}

function goHome() {
  fireEvent.click(screen.getByRole("button", { name: "Go to a route" }));
  const box = screen.getByRole("textbox", { name: "Search or type a route" });
  fireEvent.change(box, { target: { value: "/" } });
  fireEvent.keyDown(box, { key: "Enter" });
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("WebsitePreview openPath", () => {
  it("stays on Home until a change ships, then opens that change's route", () => {
    apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const view = render(ui(null));
    expect(frameSrc(view.container)).toBe(APP_URL);
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();

    view.rerender(ui({ path: "/laptops", nonce: "r1" }));
    expect(frameSrc(view.container)).toBe(`${APP_URL}/laptops`);
    expect(screen.getByRole("button", { name: "/laptops" })).toBeTruthy();
  });

  it("lets the user go back to Home and does not drag them back on the next render of the same change", () => {
    apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const view = render(ui(null));
    view.rerender(ui({ path: "/laptops", nonce: "r1" }));
    goHome();
    expect(frameSrc(view.container)).toBe(`${APP_URL}/`);
    view.rerender(ui({ path: "/laptops", nonce: "r1" }));
    expect(frameSrc(view.container)).toBe(`${APP_URL}/`);

    view.rerender(ui({ path: "/cart", nonce: "r2" }));
    expect(frameSrc(view.container)).toBe(`${APP_URL}/cart`);
  });

  it("opens the route when the preview remounts onto the new build right after the ship", () => {
    apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const view = render(ui({ path: "/laptops", nonce: "r1" }, "https://spoke-v2.zaviagent.com"));
    expect(frameSrc(view.container)).toBe("https://spoke-v2.zaviagent.com/laptops");
  });

  it("keeps the opened route under the engineer proxy and its token when the next refine swaps the frame", () => {
    apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const cart = { path: "/cart", nonce: "r1" };
    const view = render(ui(cart));
    expect(frameSrc(view.container)).toBe(`${APP_URL}/cart`);
    view.rerender(ui(cart, PROXY));
    expect(frameSrc(view.container)).toBe(`${PROXY_ROOT}cart?__pt=tok.en`);
    view.unmount();
    const remounted = render(ui(cart, PROXY));
    expect(frameSrc(remounted.container)).toBe(`${PROXY_ROOT}cart?__pt=tok.en`);
  });

  it("ignores a hostile route and keeps the frame on the app's own origin", () => {
    apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const view = render(ui(null));
    view.rerender(ui({ path: "//evil.com/x", nonce: "r1" }));
    expect(frameSrc(view.container)).toBe(APP_URL);
    view.rerender(ui({ path: "javascript:alert(1)", nonce: "r2" }));
    expect(frameSrc(view.container)).toBe(APP_URL);
  });
});

describe("previewUrlAtPath", () => {
  it("resolves a root-relative route against the frame's origin", () => {
    expect(previewUrlAtPath("https://abc.e2b.app/", "/laptops")).toBe("https://abc.e2b.app/laptops");
    expect(previewUrlAtPath("https://x.dev/some/page", "/cart?x=1")).toBe("https://x.dev/cart?x=1");
  });

  it("resolves a route under the engineer proxy prefix and keeps the proxy token", () => {
    expect(previewUrlAtPath(PROXY, "/cart")).toBe(`${PROXY_ROOT}cart?__pt=tok.en`);
    expect(previewUrlAtPath(`${PROXY_ROOT}about?__pt=tok.en`, "/cart")).toBe(`${PROXY_ROOT}cart?__pt=tok.en`);
    expect(previewUrlAtPath(PROXY, "/shop/cart?size=m#top")).toBe(`${PROXY_ROOT}shop/cart?__pt=tok.en&size=m#top`);
    expect(previewUrlAtPath(PROXY, "/cart?__pt=forged")).toBe(`${PROXY_ROOT}cart?__pt=tok.en`);
    expect(previewUrlAtPath("https://app.example.com/", "/cart")).toBe("https://app.example.com/cart");
  });

  it("never lets a route climb out of the engineer proxy prefix", () => {
    expect(previewUrlAtPath(PROXY, "/%2e%2e/%2e%2e/tenants")).toBeNull();
    expect(previewUrlAtPath(PROXY, "/../x")).toBeNull();
  });

  it("returns null for Home, no frame, or anything that could leave the origin", () => {
    expect(previewUrlAtPath(APP_URL, "/")).toBeNull();
    expect(previewUrlAtPath(null, "/laptops")).toBeNull();
    expect(previewUrlAtPath(APP_URL, null)).toBeNull();
    expect(previewUrlAtPath(APP_URL, "//evil.com")).toBeNull();
    expect(previewUrlAtPath(APP_URL, "/\\evil.com")).toBeNull();
    expect(previewUrlAtPath(APP_URL, "../x")).toBeNull();
    expect(previewUrlAtPath("not a url", "/laptops")).toBeNull();
  });
});

describe("url bar inside the engineer-preview proxy", () => {
  const proxied = "https://api.zaviagent.com/api/workspace/engineer-preview/run-1/?__pt=tok";

  it("a typed route stays inside the proxy and keeps the token", () => {
    expect(resolveNav("/laptops", "https://api.zaviagent.com", proxied)).toBe(
      "https://api.zaviagent.com/api/workspace/engineer-preview/run-1/laptops?__pt=tok",
    );
    expect(resolveNav("/", "https://api.zaviagent.com", proxied)).toBe(
      "https://api.zaviagent.com/api/workspace/engineer-preview/run-1/?__pt=tok",
    );
  });

  it("the address label shows the app route, never the proxy prefix or token", () => {
    expect(pathFromUrl("https://api.zaviagent.com/api/workspace/engineer-preview/run-1/laptops?__pt=tok")).toBe(
      "/laptops",
    );
  });

  it("outside the proxy a route still resolves against the app origin", () => {
    expect(resolveNav("/laptops", "https://app.example.com", "https://app.example.com/")).toBe(
      "https://app.example.com/laptops",
    );
  });
});
