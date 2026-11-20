// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
const ws = vi.hoisted(() => ({ tenantName: "Northwind Clinic" as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner", tenantName: ws.tenantName }) }));

import { EmailTemplateBlock } from "../EmailCampaignSettingsBlocks";

const SAVED = {
  logo_url: "https://cdn.northwind.test/logo.png",
  brand_color: "#2e7d32",
  button_color: "#1565c0",
  font_key: "system",
  sign_off: "The Northwind team",
  postal_address: "400 Elm St, Springfield",
  show_cards: false,
};

const fetchSpy = vi.fn();

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  ws.tenantName = "Northwind Clinic";
  routes["GET /api/workspace/email-template"] = { status: 200, body: { template: SAVED, fonts: ["system", "georgia"], can_edit: true } };
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const frame = () => screen.getByTitle("Email template preview") as HTMLIFrameElement;
const doc = () => frame().getAttribute("srcdoc") ?? "";
const parsed = () => new DOMParser().parseFromString(doc(), "text/html");
const part = (name: string) => parsed().querySelector(`[data-part="${name}"]`) as HTMLElement | null;
const buttonColor = () => part("button")?.getAttribute("bgcolor");
const brandColor = () => part("initial")?.style.backgroundColor;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const writes = () => calls.filter((c) => c.method !== "GET");

async function mount() {
  render(<EmailTemplateBlock />);
  await waitFor(() => expect(screen.getByTitle("Email template preview")).toBeDefined());
}

describe("brand template live preview", () => {
  it("renders the saved template with sample content, labelled Preview, in a fixed scrolling frame", async () => {
    await mount();
    const preview = screen.getByTestId("brand-preview");
    expect(within(preview).getByText("Preview").className).toContain("text-[12px]");
    expect(within(preview).getByText("Preview").className).toContain("text-inkMuted");
    const scroll = frame().parentElement!;
    expect(scroll.getAttribute("data-testid")).toBe("brand-preview-scroll");
    expect(scroll.className.split(" ")).toEqual(expect.arrayContaining(["h-full", "overflow-y-auto"]));
    expect(scroll.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["rounded-xl", "border", "border-rule", "overflow-hidden", "h-[360px]"]));
    expect(frame().getAttribute("sandbox")).toBe("allow-same-origin");
    expect(buttonColor()).toBe("#1565c0");
    expect(doc()).not.toContain("#2e7d32");
    expect(part("logo")?.getAttribute("src")).toBe("https://cdn.northwind.test/logo.png");
    expect(parsed().body.textContent).toContain("This week at Northwind Clinic");
    expect(parsed().body.textContent).toContain("Shop now");
    expect(part("sign-off")?.textContent).toBe("The Northwind team");
    expect(part("footer")?.textContent).toContain("400 Elm St, Springfield");
    expect(part("card")).toBeNull();
  });

  it("updates on every keystroke before any save, and never calls the network", async () => {
    await mount();
    const before = calls.length;
    type("Button color", "#c2185b");
    expect(buttonColor()).toBe("#c2185b");
    type("Sign-off", "See you soon, Dr. Lee & co <script>alert(1)</script>");
    expect(part("sign-off")?.innerHTML).toBe("See you soon, Dr. Lee &amp; co &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(parsed().querySelector("script")).toBeNull();
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "georgia" } });
    expect(part("button")?.innerHTML).toContain("Georgia");
    fireEvent.click(screen.getByRole("switch", { name: "Show product cards" }));
    expect(parsed().querySelectorAll('[data-part="card"]')).toHaveLength(2);
    expect(calls.length).toBe(before);
    expect(writes()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save template" })).toBeDefined();
  });

  it("an invalid hex keeps the last valid color; a short hex is expanded", async () => {
    await mount();
    type("Button color", "#c2185b");
    expect(buttonColor()).toBe("#c2185b");
    for (const bad of ["#c2185", "#zzz", "red", "", "#c2185b; background:url(https://x.test)", "#12345g"]) {
      type("Button color", bad);
      expect(buttonColor()).toBe("#c2185b");
    }
    expect(doc()).not.toContain("url(https://x.test)");
    type("Button color", "#ABC");
    expect(buttonColor()).toBe("#aabbcc");
    type("Logo link", "");
    expect(brandColor()).toBe("rgb(46, 125, 50)");
    type("Brand color", "nope");
    expect(brandColor()).toBe("rgb(46, 125, 50)");
    type("Brand color", "#000");
    expect(brandColor()).toBe("rgb(0, 0, 0)");
    type("Brand color", "#00");
    expect(brandColor()).toBe("rgb(0, 0, 0)");
  });

  it("a logo that is not a plain https address never reaches the preview", async () => {
    await mount();
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(document.cookie)",
      "http://cdn.northwind.test/logo.png",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "//cdn.northwind.test/logo.png",
      "https://user:pw@cdn.northwind.test/logo.png",
      "cdn.northwind.test/logo.png",
    ]) {
      type("Logo link", bad);
      expect(part("logo")).toBeNull();
      expect(parsed().querySelectorAll("img")).toHaveLength(0);
      expect(doc().toLowerCase()).not.toContain("javascript:");
      expect(doc()).not.toContain("http://");
      expect(doc()).not.toContain("data:");
      expect(doc()).not.toContain("user:pw");
      expect(part("name")?.textContent).toBe("Northwind Clinic");
    }
    type("Logo link", 'https://cdn.northwind.test/a.png?x="><script>');
    expect(part("logo")?.getAttribute("src")).toBe("https://cdn.northwind.test/a.png?x=%22%3E%3Cscript%3E");
    expect(parsed().querySelector("script")).toBeNull();
  });

  it("falls back to Your business and Your postal address, and escapes the workspace name", async () => {
    ws.tenantName = null;
    routes["GET /api/workspace/email-template"] = { status: 200, body: { template: { ...SAVED, postal_address: null, logo_url: null }, fonts: ["system"], can_edit: true } };
    await mount();
    expect(parsed().body.textContent).toContain("This week at Your business");
    expect(part("name")?.textContent).toBe("Your business");
    expect(part("footer")?.textContent).toContain("Your postal address");
    cleanup();
    ws.tenantName = 'Fish & <b onmouseover="x">Chips</b>';
    await mount();
    expect(part("name")?.textContent).toBe('Fish & <b onmouseover="x">Chips</b>');
    expect(parsed().querySelector("b")).toBeNull();
  });

  it("mirrors the sent email layout: warm canvas, hairline card, small initial badge, no accent bar, hairline detail line, footer under the card", async () => {
    routes["GET /api/workspace/email-template"] = { status: 200, body: { template: { ...SAVED, logo_url: null, sign_off: "", show_cards: true }, fonts: ["system"], can_edit: true } };
    ws.tenantName = "northwind Clinic";
    await mount();
    const d = parsed();
    const at = (name: string) => d.querySelector(`[data-part="${name}"]`) as HTMLElement;
    expect(part("brand-bar")).toBeNull();
    expect(part("accent")).toBeNull();
    expect(d.querySelectorAll('td[style*="height:4px"]')).toHaveLength(0);
    for (const old of ["#f3f4f6", "#e5e7eb", "#f9fafb", "#f0f1f3", "border-radius:16px"]) expect(doc()).not.toContain(old);
    expect(d.body.getAttribute("style")).toContain("background-color:#f7f6f3");
    const card = at("email")!;
    expect(card.getAttribute("style")).toContain("max-width:560px");
    expect(card.getAttribute("style")).toContain("border:1px solid #e6e3db;border-radius:12px");
    const rows = Array.from(card.querySelectorAll(":scope > tbody > tr"));
    const badge = at("initial")!;
    expect(badge.textContent).toBe("N");
    expect(badge.getAttribute("width")).toBe("28");
    expect(badge.getAttribute("bgcolor")).toBe("#2e7d32");
    expect(badge.style.backgroundColor).toBe("rgb(46, 125, 50)");
    expect(badge.style.color).toBe("rgb(255, 255, 255)");
    expect(badge.nextElementSibling).toBe(at("name"));
    expect(at("name")!.textContent).toBe("northwind Clinic");
    expect(rows[0]!.contains(badge)).toBe(true);
    expect(rows[0]!.querySelector("td")!.getAttribute("style")).not.toContain("border-bottom");
    expect(rows[1]!.textContent).toBe("This week at northwind Clinic");
    expect(rows[1]!.querySelector("td")!.getAttribute("style")).toContain("font-size:26px;line-height:1.25");
    const hero = at("hero")!;
    expect(rows[2]!.contains(hero)).toBe(true);
    expect(hero.getAttribute("style")).toContain("border-top:1px solid #e6e3db;border-bottom:1px solid #e6e3db");
    expect(hero.getAttribute("bgcolor")).toBeNull();
    expect(hero.getAttribute("style")).not.toContain("#2e7d32");
    expect(at("button")!.getAttribute("style")).toContain("border-radius:8px");
    expect(at("button")!.innerHTML).toContain("padding:14px 26px");
    const cards = Array.from(d.querySelectorAll('[data-part="card"] > table')) as HTMLElement[];
    expect(cards).toHaveLength(2);
    for (const c of cards) expect(c.getAttribute("style")).toContain("border:1px solid #e6e3db;border-radius:10px");
    expect((d.querySelector('[data-part="price"]') as HTMLElement).style.color).toBe("rgb(46, 125, 50)");
    const footer = at("footer")!;
    expect(card.contains(footer)).toBe(false);
    expect(footer.getAttribute("bgcolor")).toBeNull();
    expect(footer.getAttribute("style")).toContain("font-size:12px;line-height:1.6;color:#77716a;");
    expect(footer.closest("table")!.previousElementSibling).toBe(card);
    expect(footer.textContent).toBe("northwind Clinic400 Elm St, SpringfieldUnsubscribe");
    expect(card.parentElement!.closest("table")!.parentElement!.tagName).toBe("BODY");
    expect(d.body.children).toHaveLength(1);
    type("Brand color", "#fde047");
    expect(part("initial")!.style.color).toBe("rgb(17, 24, 39)");
    expect(part("initial")!.style.backgroundColor).toBe("rgb(253, 224, 71)");
  });

  it("builds the initial from the first whole character and escapes it; a logo replaces the badge", async () => {
    ws.tenantName = "\u{1F600}mile Dental";
    routes["GET /api/workspace/email-template"] = { status: 200, body: { template: { ...SAVED, logo_url: null }, fonts: ["system"], can_edit: true } };
    await mount();
    expect(part("initial")!.textContent).toBe("\u{1F600}");
    cleanup();
    ws.tenantName = "<b>x</b>";
    await mount();
    expect(part("initial")!.innerHTML).toBe("&lt;");
    expect(parsed().querySelector("b")).toBeNull();
    type("Logo link", "https://cdn.northwind.test/logo.png");
    expect(part("logo")).not.toBeNull();
    expect(part("initial")).toBeNull();
    expect(part("name")).toBeNull();
    const d = parsed();
    expect(d.querySelector('[data-part="email"]')!.contains(d.querySelector('[data-part="footer"]'))).toBe(false);
    expect(d.querySelector('[data-part="footer"]')!.textContent).toContain("400 Elm St, Springfield");
  });

  it("sits side by side from a 760px container and stacks below it, with no fixed page width", async () => {
    await mount();
    const preview = screen.getByTestId("brand-preview");
    const column = preview.parentElement!;
    const grid = column.parentElement!;
    expect(grid.parentElement!.className).toContain("[container-type:inline-size]");
    expect(grid.className.split(" ")).toContain("[@container(min-width:760px)]:grid-cols-[minmax(0,1fr)_minmax(0,340px)]");
    expect(grid.className.split(" ")).toContain("grid");
    expect(grid.firstElementChild!.contains(screen.getByLabelText("Logo link"))).toBe(true);
    expect(grid.lastElementChild).toBe(column);
    expect(column.className).toContain("min-w-0");
  });
});
