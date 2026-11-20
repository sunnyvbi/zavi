// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { JSX } from "react";

vi.mock("next/headers", () => ({ cookies: () => ({}) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/supabase", () => ({ createServerSupabase: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) } }) }));
vi.mock("@/lib/tenant", () => ({ fetchActiveTenant: async () => ({ id: "t-1" }) }));
vi.mock("@/components/email/EmailCampaignCard", () => ({
  EmailCampaignCard: ({ rail, id }: { rail: string; id: string }) => <div data-testid="email-card" data-rail={rail} data-id={id} />,
}));

import EmailCardPage from "./page";

const ID = "22222222-2222-4222-8222-222222222222";
afterEach(cleanup);

it("has a page heading, and Back goes to the Email campaigns channel", async () => {
  render(await EmailCardPage({ params: Promise.resolve({ rail: "decisions", id: ID }) }));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Email campaign");
  const back = screen.getByRole("link", { name: /Back to Email campaigns/ }) as HTMLAnchorElement;
  expect(back.getAttribute("href")).toBe("/workspace?tab=channels&channel=email_marketing");
  expect(screen.getByTestId("email-card").dataset.rail).toBe("decisions");
});

it("sits inside the workspace-shell dark-mode scope, heading and card included", async () => {
  render(await EmailCardPage({ params: Promise.resolve({ rail: "channel_actions", id: ID }) }));
  const shell = screen.getByRole("heading", { level: 1 }).closest(".workspace-shell") as HTMLElement | null;
  expect(shell).not.toBeNull();
  expect(shell!.className).toMatch(/\bbg-cream\b/);
  expect(shell!.className).toMatch(/\btext-ink\b/);
  expect(shell!.contains(screen.getByRole("link", { name: /Back to Email campaigns/ }))).toBe(true);
  expect(shell!.contains(screen.getByTestId("email-card"))).toBe(true);
});

async function nearestNotFound() {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const appDir = path.resolve(__dirname, "../../../..");
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "not-found.tsx"))) {
    if (dir === appDir) throw new Error("no not-found boundary");
    dir = path.dirname(dir);
  }
  return (await import(path.join(dir, "not-found.tsx"))).default as () => JSX.Element;
}

it.each([
  ["bad rail", "bogus-rail", ID],
  ["bad uuid", "decisions", "not-a-uuid"],
])("a malformed link (%s) lands on the email not-found inside the workspace look, not the site 404", async (_label, rail, id) => {
  await expect(EmailCardPage({ params: Promise.resolve({ rail, id }) })).rejects.toThrow("not_found");
  const NotFound = await nearestNotFound();
  render(<NotFound />);
  expect(screen.getByText("That email link is not right. Open Email campaigns to find your emails.")).toBeTruthy();
  const back = screen.getByRole("link", { name: /Back to Email campaigns/ }) as HTMLAnchorElement;
  expect(back.getAttribute("href")).toBe("/workspace?tab=channels&channel=email_marketing");
  expect(back.closest(".workspace-shell")).not.toBeNull();
  expect(screen.queryByText(/Marketing home/)).toBeNull();
  expect(screen.queryByText(/skill misfired/i)).toBeNull();
});

it("a well-formed id still renders the card, which owns the not-found-by-id path", async () => {
  render(await EmailCardPage({ params: Promise.resolve({ rail: "decisions", id: "33333333-3333-4333-8333-333333333333" }) }));
  expect(screen.getByTestId("email-card").dataset.id).toBe("33333333-3333-4333-8333-333333333333");
  expect(screen.queryByText(/That email link is not right/)).toBeNull();
});

it.each([
  ["the card page", async () => render(await EmailCardPage({ params: Promise.resolve({ rail: "decisions", id: ID }) }))],
  ["the email not-found", async () => {
    const NotFound = await nearestNotFound();
    render(<NotFound />);
  }],
])("%s drops below the service outage banner so the banner never covers Back", async (_label, mount) => {
  await mount();
  const back = screen.getByRole("link", { name: /Back to Email campaigns/ });
  const offset = back.parentElement as HTMLElement;
  expect(offset.className.split(/\s+/)).toContain("mt-[var(--service-banner-h,0px)]");
  expect(offset.closest(".workspace-shell")).not.toBeNull();
});

function stubSystemDark(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" && matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

describe("the email not-found applies the workspace theme itself, since the 404 is client-rendered and the boot script never runs", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
    vi.unstubAllGlobals();
  });

  it("a stored dark preference turns the page dark, theme-color included", async () => {
    stubSystemDark(false);
    window.localStorage.setItem("zavi:dark", "1");
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#F7F6F3";
    document.head.append(meta);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    const NotFound = await nearestNotFound();
    render(<NotFound />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(meta.content).toBe("#141414");
    cleanup();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("no stored preference follows a dark system setting", async () => {
    stubSystemDark(true);
    const NotFound = await nearestNotFound();
    render(<NotFound />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("a stored light preference stays light on a dark system", async () => {
    stubSystemDark(true);
    window.localStorage.setItem("zavi:dark", "0");
    document.documentElement.classList.add("dark");
    const NotFound = await nearestNotFound();
    render(<NotFound />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("storage that throws on read still follows a dark system setting", async () => {
    stubSystemDark(true);
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      const NotFound = await nearestNotFound();
      render(<NotFound />);
      expect(getItem).toHaveBeenCalledWith("zavi:dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    } finally {
      getItem.mockRestore();
    }
  });
});
