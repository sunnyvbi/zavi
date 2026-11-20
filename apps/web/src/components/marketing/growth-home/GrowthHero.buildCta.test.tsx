// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("./fonts", () => ({ jakartaHeavy: { className: "" }, caveat: { className: "" } }));
vi.mock("@/lib/api", () => ({ apiUrl: (path: string) => `http://api.test${path}` }));

import { GrowthHero, NoWebsiteNote } from "./GrowthHero";
import { resetWebsiteFramingForTests } from "@/lib/workspace/buildFraming";

let answer: () => Promise<Response>;
const fetchMock = vi.fn((_url: string) => answer());
const flags = (body: Record<string, unknown>) => {
  answer = async () => ({ ok: true, status: 200, json: async () => body }) as Response;
};

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  resetWebsiteFramingForTests();
  fetchMock.mockClear();
  push.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const buildDoor = () => screen.getByRole("link", { name: /Create your website/ });

describe("B15: the home hero has a clear build-a-website door", () => {
  it("with home_build_cta on, 'Create your website' is an underlined link with an icon to the idea step, beside the growth box", async () => {
    flags({ home_build_cta: true });
    render(<GrowthHero startHref="/start" />);
    await settle();
    const door = buildDoor();
    expect(door.getAttribute("href")).toBe("/start?step=idea");
    expect(door.getAttribute("data-testid")).toBe("home-build-website-cta");
    const cls = door.className.split(" ");
    expect(cls).toContain("min-h-11");
    expect(door.querySelector(".underline")?.textContent).toBe("Create your website");
    const primary = screen.getByRole("button", { name: /Grow my business/ });
    for (const c of ["min-h-12", "rounded-full", "px-6", "text-[16px]", "font-semibold"]) expect(primary.className.split(" ")).toContain(c);
    expect(door.closest("form")).toBe(primary.closest("form"));
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/public/build-framing", expect.anything());
  });

  it("a tagged link's utm_* ride the build door too, in both the hero and the closing call to action", async () => {
    flags({ home_build_cta: true });
    render(<GrowthHero startHref="/start?utm_source=x&utm_campaign=launch2" />);
    await settle();
    expect(buildDoor().getAttribute("href")).toBe("/start?utm_source=x&utm_campaign=launch2&step=idea");
    cleanup();
    render(<NoWebsiteNote tone="dark" small startHref="/start?utm_source=email" />);
    await settle();
    expect(buildDoor().getAttribute("href")).toBe("/start?utm_source=email&step=idea");
  });

  it("the primary box still starts the growth flow at /start", async () => {
    flags({ home_build_cta: true });
    render(<GrowthHero startHref="/start" />);
    await settle();
    fireEvent.submit(screen.getByRole("button", { name: /Grow my business/ }).closest("form")!);
    expect(push).toHaveBeenCalledWith("/start");
  });

  it("the dark closing call to action gets the same button in its dark colours", async () => {
    flags({ home_build_cta: true });
    render(<NoWebsiteNote tone="dark" small />);
    await settle();
    const cls = buildDoor().className.split(" ");
    expect(cls).toContain("min-h-12");
    expect(cls).toContain("text-white");
    expect(cls).toContain("border-white/20");
  });

  it("with the key off, it stays the small underlined link", async () => {
    flags({ home_build_cta: false });
    render(<GrowthHero startHref="/start" />);
    await settle();
    const door = buildDoor();
    expect(door.getAttribute("href")).toBe("/start?step=idea");
    expect(door.className.split(" ")).toContain("underline");
    expect(screen.queryByTestId("home-build-website-cta")).toBeNull();
  });

  it("a failed flags read falls back to the key's default, the full-size button, never the old link", async () => {
    answer = async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;
    render(<GrowthHero startHref="/start" />);
    await settle();
    const door = buildDoor();
    expect(door.getAttribute("data-testid")).toBe("home-build-website-cta");
    expect(door.className.split(" ")).not.toContain("underline");
  });
});

describe("the hero box keeps the no-card promise", () => {
  it("shows 'Free to start. No card, no sales call.' beside the no-website door", async () => {
    flags({ home_build_cta: false });
    render(<GrowthHero startHref="/start" />);
    await settle();
    expect(screen.getByText("Free to start. No card, no sales call.")).toBeTruthy();
    expect(buildDoor()).toBeTruthy();
  });
});

