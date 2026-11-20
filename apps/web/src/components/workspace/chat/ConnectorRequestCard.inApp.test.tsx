// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.zaviagent.com"}
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectorRequest } from "@zavi/shared";

const h = vi.hoisted(() => ({ api: vi.fn(), connect: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.api }));
vi.mock("@/app/connectors/connectStrategies", async original => ({
  ...(await original<typeof import("@/app/connectors/connectStrategies")>()), launchConnect: h.connect,
}));
import { ConnectorRequestCard } from "./ConnectorRequestCard";

const request: ConnectorRequest = {kind:"connector_request",v:1,request_id:"req",run_id:"run",slug:"meta_ads",label:"Meta Ads",connect:"oauth",mode:"connect",origin:"tool_error",reason:"",created_at:"2026-11-04T00:00:00Z"};
const thread = "00000000-0000-4000-8000-000000000001";
const company = "00000000-0000-4000-8000-000000000002";
const ios = "Mozilla/5.0 (iPhone) Mobile/15E148 Twitter for iPhone";
const android = "Mozilla/5.0 (Linux; Android 14; wv) TwitterAndroid";
function userAgent(value: string) { vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(value); }
beforeEach(() => {
  h.api.mockResolvedValue({ok:true,json:async()=>({connectors:[]})}); h.copy.mockResolvedValue(undefined);
  Object.defineProperty(window.navigator,"clipboard",{configurable:true,value:{writeText:h.copy}});
  window.localStorage.clear();
  window.history.replaceState({},"",`/workspace/${thread}?company=${company}&error=secret&access_token=secret&unknown=private#access_token=secret`);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); window.history.replaceState({},"","/"); });

it.each([[ios,"Safari"],[android,"Chrome"]])("offers an external browser for %s without launching a connection", async (ua, browser) => {
  userAgent(ua); render(<ConnectorRequestCard request={request}/>);
  const link = await screen.findByRole("link",{name:`Open in ${browser}`});
  expect(link.getAttribute("href")).toContain(`/workspace/${thread}`);
  expect(link.getAttribute("href")).not.toContain("secret");
  expect(link.getAttribute("href")).not.toContain("private");
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.api.mock.calls.every(([path])=>path==="/api/connectors")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Copy link"}));
  await waitFor(()=>expect(h.copy).toHaveBeenCalledWith(`${window.location.origin}/workspace/${thread}?company=${company}`));
  expect(await screen.findByText("Link copied")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Connect Meta Ads"}));
  await waitFor(()=>expect(h.connect).toHaveBeenCalledOnce());
});

it("does not add browser help on desktop or for paste-key connectors", async () => {
  userAgent("Mozilla/5.0 Chrome/130 Safari/537.36"); const view=render(<ConnectorRequestCard request={request}/>);
  await waitFor(()=>expect(h.api).toHaveBeenCalled());
  expect(screen.queryByRole("button",{name:"Copy link"})).toBeNull();
  view.unmount(); userAgent(ios); render(<ConnectorRequestCard request={{...request,slug:"stripe",label:"Stripe",connect:"key_form"}}/>);
  expect(screen.queryByRole("button",{name:"Copy link"})).toBeNull();
});

it("offers a manual clean link when clipboard access fails", async () => {
  userAgent(ios); h.copy.mockRejectedValueOnce(Error("denied")); render(<ConnectorRequestCard request={request}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Copy link"}));
  expect(await screen.findByText(`${window.location.origin}/workspace/${thread}?company=${company}`)).toBeTruthy();
  expect(h.connect).not.toHaveBeenCalled();
});

it("offers the manual link if opening another browser leaves the page visible", async () => {
  userAgent(ios); render(<ConnectorRequestCard request={request}/>);
  const link=await screen.findByRole("link",{name:"Open in Safari"});
  vi.useFakeTimers();
  link.addEventListener("click", event=>event.preventDefault()); fireEvent.click(link);
  await act(async()=>{vi.advanceTimersByTime(1600);});
  expect(screen.getByText(`${window.location.origin}/workspace/${thread}?company=${company}`)).toBeTruthy();
  expect(h.connect).not.toHaveBeenCalled();
});

it("removes browser help once connected and still waits for Continue", async () => {
  userAgent(android); h.api.mockResolvedValue({ok:true,json:async()=>({connectors:[{slug:"meta_ads"}]})});
  render(<ConnectorRequestCard request={request}/>);
  expect(await screen.findByRole("button",{name:"Continue"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Copy link"})).toBeNull();
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.api.mock.calls.every(([path])=>path==="/api/connectors")).toBe(true);
});

it("keeps a Composio card's known chat destination and drops unknown query fields", async () => {
  userAgent(android);
  window.history.replaceState({},"",`/workspace?tab=growth-strategy&chat=${thread}&company=${company}&agent=operator&channel=seo&token=private&next=https://example.com&state=private`);
  render(<ConnectorRequestCard request={{...request,slug:"composio.gmail",label:"Gmail",connect:"composio"}}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Copy link"}));
  await waitFor(()=>expect(h.copy).toHaveBeenCalledOnce());
  const url=new URL(h.copy.mock.calls[0][0]);
  expect(Object.fromEntries(url.searchParams)).toEqual({company,chat:thread,agent:"operator",channel:"seo",tab:"growth-strategy"});
  expect(h.connect).not.toHaveBeenCalled();
});

it("uses the current workspace identity over a stale company query", async () => {
  userAgent(ios);
  const activeCompany="00000000-0000-4000-8000-000000000003";
  render(<ConnectorRequestCard request={request} companyId={activeCompany}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Copy link"}));
  await waitFor(()=>expect(h.copy).toHaveBeenCalledWith(`${window.location.origin}/workspace/${thread}?company=${activeCompany}`));
});

it("opens the rendered build side chat rather than the surrounding build page", async () => {
  userAgent(ios);
  const activeCompany="00000000-0000-4000-8000-000000000003";
  window.history.replaceState({},"",`/workspace?tab=build&build=site-id&buildThread=${company}&company=${company}&access_token=private#state=private`);
  render(<ConnectorRequestCard request={request} companyId={activeCompany} threadId={thread}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Copy link"}));
  await waitFor(()=>expect(h.copy).toHaveBeenCalledWith(`${window.location.origin}/workspace/${thread}?company=${activeCompany}`));
});
