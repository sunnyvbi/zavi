// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import Link from "next/link";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { attributionLink, installAttributionLinks } from "./attributionLinks";
import { urlAttribution } from "./liveFrom";
import { LiveRunBanner } from "@/app/start/LiveRunBanner";
const origin = window.location.origin;
const tags = [
  "from=newsletter-morning-blue", "from=filter-coffee", "from=live-upcar",
  "utm_source=aishorthand.beehiiv.com&utm_medium=newsletter&utm_campaign=chatgpt-just-gave-gpt-6-to-every-user",
  "utm_source=chatgpt.com", "utm_source=ig&utm_medium=social",
];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });
it.each(["/", "/pricing", "/blog/launch", "/start"])("retains every regression tag from %s through navigation and signup", path => {
  for (const query of tags) {
    const first = `${origin}${path}?${query}`;
    const pricing = attributionLink("/pricing", first);
    const start = attributionLink("/start?step=idea", origin + pricing);
    const login = attributionLink(`/login?next=${encodeURIComponent(start)}`, origin + start);
    const next = new URL(login, origin).searchParams.get("next")!;
    expect(urlAttribution(new URL(next, origin).search)).toEqual(urlAttribution(query));
  }
});
it("keeps destination campaigns, anchors and plan choices", () => {
  const current = `${origin}/pricing?from=filter-coffee&utm_source=old&utm_campaign=old`;
  expect(attributionLink("/start?plan=growth&term=6mo#form", current)).toBe("/start?plan=growth&term=6mo&utm_source=old&utm_campaign=old&from=filter-coffee#form");
  expect(attributionLink("/start?utm_source=chosen&from=chosen", current)).toBe("/start?utm_source=chosen&from=chosen");
});
it.each(["https://elsewhere.test/start", "//elsewhere.test/start", "/oauth/consent?req=x", "/workspace", "/creator", "/creators/apply", "/auth/callback", "/api/test", "/login?next=/oauth/consent%3Freq%3Dx", "#pricing", "mailto:a@example.com"])("leaves unrelated navigation %s unchanged", href => {
  expect(attributionLink(href, `${origin}/pricing?from=filter-coffee`)).toBe(href);
});
it("has no effect without URL tags or inside authenticated product routes", () => {
  expect(attributionLink("/start", `${origin}/pricing`)).toBe("/start");
  expect(attributionLink("/pricing", `${origin}/workspace?from=filter-coffee`)).toBe("/pricing");
});
it("only a live code shows the live-run banner", () => {
  expect(renderToStaticMarkup(<LiveRunBanner from="filter-coffee" website="" />)).toBe("");
  expect(renderToStaticMarkup(<LiveRunBanner from="live-upcar" website="" />)).toContain('href="/live/upcar"');
});
it("uses the tagged destination with a real Next Link, including after a context-menu decoration", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/pricing?from=filter-coffee");
  const navigate = vi.fn();
  const cleanup = installAttributionLinks(navigate);
  const rootEl = document.createElement("div"); document.body.append(rootEl);
  const root = createRoot(rootEl);
  const push = vi.fn();
  const router = {push, replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), hmrRefresh: vi.fn()};
  await act(async () => { root.render(<AppRouterContext.Provider value={router}><Link href="/start">Start</Link></AppRouterContext.Provider>); });
  const anchor = rootEl.querySelector("a")!;
  anchor.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true}));
  expect(anchor.getAttribute("href")).toBe("/start?from=filter-coffee");
  await act(async () => { anchor.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0})); });
  expect(navigate).toHaveBeenCalledWith("/start?from=filter-coffee");
  expect(push).not.toHaveBeenCalled();
  cleanup(); await act(async () => root.unmount()); rootEl.remove();
});

it("leaves an already-tagged /login link to Next Link instead of re-pushing it", () => {
  const href = "/login?signup=1&next=%2Fstart%3Ffrom%3Dfilter-coffee";
  expect(attributionLink(href, "https://www.zaviagent.com/?from=filter-coffee")).toBe(href);
});
