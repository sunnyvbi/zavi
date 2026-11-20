import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createZavi, type FetchLike, type KeyValueStorage, type ResponseLike } from "../files/src/zavi/client";

const SITE = "11111111-2222-4333-8444-555555555555";
const NOW = 1_800_000_000;

type Call = { path: string; body: unknown; headers: Record<string, string> };
type Route = (call: Call) => ResponseLike;

function res(status: number, body?: unknown): ResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => text };
}
function memStorage(): KeyValueStorage {
  const data: Record<string, string> = {};
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; }, removeItem: (k) => { delete data[k]; } };
}

const h = vi.hoisted(() => ({
  zavi: null as unknown,
  calls: [] as Array<{ path: string; body: unknown; headers: Record<string, string> }>,
  routes: {} as Record<string, (call: { path: string; body: unknown; headers: Record<string, string> }) => unknown>,
  navigate: [] as string[],
  search: "",
  captchaToken: null as string | null,
  captchaResets: 0,
}));

function makeZavi() {
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(String(url), "https://shop.zavi.site").pathname;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { path, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers };
    h.calls.push(call);
    const route = h.routes[path] as Route | undefined;
    return route ? route(call) : res(404, { error: { code: "not_found", message: "no route" } });
  };
  return createZavi({ fetch, origin: "https://shop.zavi.site", siteId: async () => SITE, storage: memStorage(), locks: null, now: () => NOW * 1000 });
}

vi.mock("../files/src/zavi/index", async () => {
  const errors = await import("../files/src/zavi/errors");
  return {
    get zavi() { return h.zavi; },
    ZaviError: errors.ZaviError,
  };
});
vi.mock("../files/src/zavi/captcha", () => ({
  useCaptcha: () => ({ token: h.captchaToken, widget: null, required: false, reset: () => { h.captchaResets += 1; } }),
}));
vi.mock("react-router-dom", async () => {
  const react = await import("react");
  return {
    useNavigate: () => (to: string) => { h.navigate.push(to); },
    useLocation: () => ({ pathname: "/login", search: h.search, hash: "", state: null, key: "k" }),
    Link: ({ to, children, ...rest }: { to: string; children?: unknown }) =>
      react.createElement("a", { ...rest, href: to }, children as never),
  };
});

import Login from "../files/src/pages/Login";
import Admin from "../files/src/pages/Admin";

const WRONG_PASSWORD =
  "Wrong email or password. First time? Use \"Email me a sign-in link\". Your Zavi password does not work here.";

const recoverCalls = () => h.calls.filter((c) => c.path === "/api/auth/recover");
const loginCalls = () => h.calls.filter((c) => c.path === "/api/auth/login");

function mount(search = "") {
  h.search = search;
  render(createElement(Login));
}
function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value } });
}
function typePassword(value: string) {
  fireEvent.change(screen.getByLabelText("Password"), { target: { value } });
}

beforeEach(() => {
  h.zavi = makeZavi();
  h.calls.length = 0;
  h.routes = {};
  h.navigate.length = 0;
  h.search = "";
  h.captchaToken = null;
  h.captchaResets = 0;
});
afterEach(() => cleanup());

const wrongPassword = () =>
  res(401, { error: { code: "invalid_credentials", message: "Email or password is incorrect." } });

async function signInWrong(search: string) {
  h.routes["/api/auth/login"] = wrongPassword;
  mount(search);
  typeEmail("someone@example.com");
  typePassword("not-the-password");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign in" })); });
  const error = await waitFor(() => {
    const el = document.querySelector('[data-zavi="login-error"]');
    expect(el).not.toBeNull();
    return el!;
  });
  return error.textContent;
}

const OWNER_NEUTRAL = "Wrong email or password. If you own this site, use \"Email me a sign-in link\".";

function mountAdmin(search: string) {
  h.search = search;
  render(createElement(Admin));
}

describe("site Login page: the owner's Zavi password", () => {
  it.each([
    ["a visitor who typed /admin", "", "/login?next=/admin"],
    ["an owner from Zavi", "?from=zavi", "/login?next=/admin&from=zavi"],
    ["a look-alike from value", "?from=Zavi", "/login?next=/admin"],
    ["another look-alike from value", "?from=zavi2", "/login?next=/admin"],
  ])("the admin page's sign-in link: %s", async (_label, search, href) => {
    mountAdmin(search);
    const link = await screen.findByRole("link", { name: "sign in" });
    expect(link.getAttribute("href")).toBe(href);
    expect(document.body.textContent).not.toMatch(/zavi/i);
  });

  it.each([
    ["the plain /login a customer reaches from the header", ""],
    ["a sign-in that returns to another page", "?next=/account"],
    ["a look-alike next value", "?next=/admin/../account"],
    ["from=zavi without next=/admin", "?from=zavi"],
    ["from=zavi with another next", "?next=/account&from=zavi"],
    ["from=zavi with a look-alike next", "?next=/admin/../x&from=zavi"],
  ])("a customer's wrong password never mentions Zavi: %s", async (_label, search) => {
    expect(await signInWrong(search)).toBe("Wrong email or password.");
    expect(document.body.textContent).not.toMatch(/zavi/i);
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeTruthy();
  });

  it.each([
    ["a visitor who typed /admin and was sent to sign in", "?next=/admin"],
    ["a look-alike from value", "?next=/admin&from=Zavi"],
    ["another look-alike from value", "?next=/admin&from=zavi2"],
    ["an empty from value", "?next=/admin&from="],
  ])("a wrong password on the way to /admin, not from Zavi, is brand-neutral: %s", async (_label, search) => {
    expect(await signInWrong(search)).toBe(OWNER_NEUTRAL);
    expect(document.body.textContent).not.toMatch(/zavi/i);
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
  });

  it("a visitor who opens /admin, signs in from its link and types a wrong password never sees Zavi", async () => {
    mountAdmin("");
    const href = (await screen.findByRole("link", { name: "sign in" })).getAttribute("href")!;
    cleanup();
    expect(await signInWrong(href.slice(href.indexOf("?")))).toBe(OWNER_NEUTRAL);
    expect(document.body.textContent).not.toMatch(/zavi/i);
  });

  it("an owner who opens /admin from Zavi and types a wrong password is told the Zavi password does not work", async () => {
    mountAdmin("?from=zavi");
    const href = (await screen.findByRole("link", { name: "sign in" })).getAttribute("href")!;
    cleanup();
    expect(await signInWrong(href.slice(href.indexOf("?")))).toBe(WRONG_PASSWORD);
  });

  it("a wrong password on the way to /admin from Zavi says the Zavi password does not work here and points to the email link", async () => {
    h.routes["/api/auth/login"] = wrongPassword;
    mount("?from=zavi&next=/admin");
    typeEmail("owner@zavi.co");
    typePassword("my-zavi-password");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign in" })); });
    const error = await screen.findByText(WRONG_PASSWORD);
    expect(error.getAttribute("data-zavi")).toBe("login-error");
    expect(loginCalls()).toHaveLength(1);
    expect(loginCalls()[0]!.body).toEqual({ email: "owner@zavi.co", password: "my-zavi-password" });
    expect(h.navigate).toEqual([]);
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeTruthy();
    expect(recoverCalls()).toHaveLength(0);
  });

  it("other sign-in failures keep their own message, not the Zavi password hint", async () => {
    h.routes["/api/auth/login"] = () => res(429, { error: { code: "rate_limited", message: "slow down" } });
    mount();
    typeEmail("owner@zavi.co");
    typePassword("whatever-password");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign in" })); });
    await screen.findByText("Too many attempts. Wait a minute and try again.");
    expect(document.body.textContent).not.toMatch(/Zavi password/);
  });
});

describe("site Login page: Forgot password?", () => {
  it("sends one reset request for the typed email with the captcha token, then says where the link went", async () => {
    h.routes["/api/auth/recover"] = () => res(200, { data: { sent: true } });
    h.captchaToken = "turnstile-token-1";
    mount();
    typeEmail("  owner@zavi.co ");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Forgot password?" })); });
    const sent = await waitFor(() => {
      const el = document.querySelector('[data-zavi="reset-sent"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(sent.textContent).toContain("If owner@zavi.co has an account here, a password reset link is on its way.");
    expect(sent.textContent).toContain("choose a new password");
    expect(recoverCalls()).toHaveLength(1);
    expect(recoverCalls()[0]!.body).toEqual({ email: "owner@zavi.co" });
    expect(Object.values(recoverCalls()[0]!.headers)).toContain("turnstile-token-1");
    expect(loginCalls()).toHaveLength(0);
    expect(h.calls.filter((c) => c.path === "/api/auth/magic-link")).toHaveLength(0);
    expect(h.navigate).toEqual([]);
  });

  it("with no email typed, asks for it and sends nothing", async () => {
    mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Forgot password?" })); });
    const error = document.querySelector('[data-zavi="login-error"]');
    expect(error?.textContent).toBe("Enter your email above, then press \"Forgot password?\" again.");
    expect(h.calls).toHaveLength(0);
    expect(document.querySelector('[data-zavi="reset-sent"]')).toBeNull();
  });

  it("a failed reset request shows the error, stays on the form, and resets the captcha", async () => {
    h.routes["/api/auth/recover"] = () => res(429, { error: { code: "rate_limited", message: "slow down" } });
    mount();
    typeEmail("owner@zavi.co");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Forgot password?" })); });
    await screen.findByText("Too many attempts. Wait a minute and try again.");
    expect(recoverCalls()).toHaveLength(1);
    expect(document.querySelector('[data-zavi="reset-sent"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeTruthy();
    expect(h.captchaResets).toBe(1);
  });

  it("a server error on reset does not claim a link was sent", async () => {
    h.routes["/api/auth/recover"] = () => res(500, "<html>oops</html>");
    mount();
    typeEmail("owner@zavi.co");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Forgot password?" })); });
    await screen.findByText("Something went wrong. Try again.");
    expect(document.body.textContent).not.toMatch(/reset link is on its way/);
  });
});
