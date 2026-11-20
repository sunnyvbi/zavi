// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: unknown; idempotent: boolean; key: string | null }>,
  answer: null as null | ((url: string, body: unknown) => { status: number; body: unknown }),
}));
const sessions = vi.hoisted(() => ({ changed: 0 }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(async (url: string, init?: { body?: string; idempotent?: boolean; headers?: HeadersInit }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    api.calls.push({ url, body, idempotent: init?.idempotent === true, key: new Headers(init?.headers).get("Idempotency-Key") });
    const a = api.answer!(url, body);
    return { ok: a.status < 400, status: a.status, json: async () => a.body } as Response;
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: () => void sessions.changed++ }));

import { SiteThemePanel } from "./SiteThemePanel";
import { SiteElementDesignControls, isSitePhoto } from "./SiteElementDesignControls";
import { parseEditorSelected, EDITOR_SELECTED_TYPE, type SelectedElement } from "./editorProtocol";

const APP = "site:aaaaaaaa-0000-4000-8000-000000000001";
const THEME = { name: "clean", colors: { primary: "#2563eb", background: "#ffffff", foreground: "#0f172a", accent: "#dbeafe" }, fonts: { display: "Inter", body: "Inter" }, radius: "0.5rem" };
const SECTION = { id: "services", component: "Features", variant: "cards", tone: null, variants: ["cards", "icons", "alternating", "split"], tones: ["default", "muted", "inverse"], can_move_up: true, can_move_down: false };

function state(over: Record<string, unknown> = {}) {
  return { theme: THEME, fonts: ["Inter", "Lato", "Fraunces"], radii: ["0", "0.5rem", "1rem"], section: null, section_message: null, image_ai: false, ...over };
}

beforeEach(() => {
  api.calls = [];
  sessions.changed = 0;
});
afterEach(cleanup);

describe("SiteThemePanel", () => {
  it("keeps every theme control reachable in a short viewport", async () => {
    api.answer = () => ({ status: 200, body: state({ logo_ai: true }) });
    render(<SiteThemePanel appId="site:aaaaaaaa-0000-4000-8000-000000000008" onClose={() => {}} />);
    const panel = await screen.findByRole("dialog", { name: "Site theme" });
    expect(panel.className).toContain("max-h-[calc(100dvh-96px)]");
    expect(panel.className).toContain("overflow-y-auto");
  });

  it("applies only what changed, once, and says it is saved", async () => {
    api.answer = (url, body) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state() }
        : { status: 200, body: { ok: true, theme: { ...THEME, radius: "1rem", fonts: { display: "Fraunces", body: "Inter" } }, ...(body ? {} : {}) } };
    render(<SiteThemePanel appId={APP} onClose={() => {}} />);
    const apply = await screen.findByRole("button", { name: "Apply" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Headings font" }));
    fireEvent.click(screen.getByRole("option", { name: "Fraunces" }));
    fireEvent.click(screen.getByRole("button", { name: "Corners" }));
    fireEvent.click(screen.getByRole("option", { name: "Round" }));
    fireEvent.click(apply);
    await screen.findByText(/goes live when you publish/);
    const post = api.calls.find((c) => c.body);
    expect(post!.body).toEqual({ app_id: APP, op: { kind: "theme", fonts: { display: "Fraunces" }, radius: "1rem" } });
  });

  it("shows the refusal and keeps the draft", async () => {
    api.answer = (url) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state() }
        : { status: 422, body: { error: { code: "unreadable", message: "Text would be hard to read on that background." } } };
    render(<SiteThemePanel appId={APP} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Page colour"), { target: { value: "#eeeeee" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByRole("alert")).textContent).toContain("hard to read");
    expect(screen.getByDisplayValue("#eeeeee")).toBeTruthy();
  });

  it("tells a busy site apart from a refused change, and keeps both drafts", async () => {
    const replies = [
      { status: 409, body: { error: { code: "lease_held", message: "Another change to this site is running. Try again when it finishes." } } },
      { status: 422, body: { error: { code: "unreadable", message: "Text would be hard to read on that background." } } },
    ];
    api.answer = (url) => (url.startsWith("/api/website/site-design-edit?") ? { status: 200, body: state() } : replies.shift()!);
    render(<SiteThemePanel appId="site:aaaaaaaa-0000-4000-8000-000000000013" onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Page colour"), { target: { value: "#eeeeee" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const busy = await screen.findByRole("alert");
    expect(busy.getAttribute("data-tone")).toBe("busy");
    expect(busy.textContent).toContain("Another change to this site is running");
    expect(screen.getByDisplayValue("#eeeeee")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByRole("alert").getAttribute("data-tone")).toBe("error"));
    expect(screen.getByRole("alert").textContent).toContain("hard to read");
    expect(api.calls.filter((c) => c.body)).toHaveLength(2);
  });

  it("fills the logo from an idea and counts it, sending nothing until Make logo", async () => {
    const logoApp = "site:aaaaaaaa-0000-4000-8000-000000000014";
    api.answer = () => ({ status: 200, body: state({ logo_ai: true }) });
    render(<SiteThemePanel appId={logoApp} onClose={() => {}} />);
    const field = (await openLogoTab()) as HTMLTextAreaElement;
    expect(screen.getByTestId("site-logo-count").textContent).toBe("0/400");
    expect(screen.getByRole("radio", { name: "Icon + name" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Monogram" }));
    expect(field.value).toBe("A bold monogram of the initials");
    expect(screen.getByTestId("site-logo-count").textContent).toBe(`${field.value.length}/400`);
    expect(screen.getByRole("button", { name: "Make logo" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("site-theme-apply-scope")).toBeNull();
    expect(api.calls.filter((c) => c.body)).toHaveLength(0);
  });

  it("Name only designs nothing: no description, no Make logo, and Apply drops the logo image", async () => {
    const logoApp = "site:aaaaaaaa-0000-4000-8000-000000000015";
    api.answer = (_path, body) => (!body ? { status: 200, body: state({ logo_ai: true }) } : { status: 200, body: { ok: true, theme: null, logo: null } });
    render(<SiteThemePanel appId={logoApp} onClose={() => {}} />);
    await openLogoTab();
    fireEvent.click(screen.getByRole("radio", { name: "Name only" }));
    expect(screen.queryByLabelText("Describe the logo")).toBeNull();
    expect(screen.queryByRole("button", { name: "Make logo" })).toBeNull();
    expect(screen.getByTestId("site-logo-name-only").textContent).toContain("Nothing is designed or charged");
    expect(screen.queryByTestId("site-theme-apply-scope")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/goes live when you publish/);
    const sent = api.calls.filter((c) => c.body);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ app_id: logoApp, op: { kind: "theme", logo: { name_only: true } } });
  });

  it("explains a site whose theme cannot be edited here, and a failed load", async () => {
    api.answer = () => ({ status: 200, body: state({ theme: null }) });
    render(<SiteThemePanel appId="site:aaaaaaaa-0000-4000-8000-000000000003" onClose={() => {}} />);
    await screen.findByText(/can't be changed here/);
    cleanup();
    api.answer = () => ({ status: 503, body: { error: { message: "The preview isn't running right now." } } });
    render(<SiteThemePanel appId="site:aaaaaaaa-0000-4000-8000-000000000002" onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("isn't running");
  });

  const openLogoTab = async () => {
    fireEvent.click(await screen.findByRole("tab", { name: "Logo" }));
    return screen.getByLabelText("Describe the logo");
  };

  const PREVIEW = (id: string, free: boolean) => ({ status: 200, body: { ok: true, preview: { id, src: "data:image/svg+xml;base64,PHN2Zy8+", free } } });
  const isPreview = (body: unknown) => (body as { op?: { kind?: string } } | null)?.op?.kind === "logo_preview";
  const makeLogo = async (text: string) => {
    fireEvent.change(screen.getByLabelText("Describe the logo"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: /Make (logo|another)/ }));
    await screen.findByAltText("Logo preview");
  };

  it("shows the logo before Apply: Make logo previews it (site unchanged), then Apply saves that preview", async () => {
    const logoApp = "site:aaaaaaaa-0000-4000-8000-000000000009";
    api.answer = (url, body) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state({ logo_ai: true, logo_preview_free: true }) }
        : isPreview(body)
          ? PREVIEW("p-1", true)
          : { status: 200, body: { ok: true, logo: { src: "/images/logo.svg" } } };
    render(<SiteThemePanel appId={logoApp} onClose={() => {}} />);
    expect((await screen.findByRole("tab", { name: "Theme" })).getAttribute("aria-selected")).toBe("true");
    await openLogoTab();
    expect(screen.getByTestId("site-logo-cost").textContent).toBe("Your first logo for this site is free.");
    expect(screen.getByTestId("site-logo-swatches").querySelectorAll("span")).toHaveLength(4);
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    await makeLogo("a geometric hummingbird made from two shapes");
    const posts = () => api.calls.filter((call) => call.body);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({ app_id: logoApp, op: { kind: "logo_preview", description: "a geometric hummingbird made from two shapes", colors: { primary: "#2563eb", accent: "#dbeafe" } } });
    expect(posts()[0]!.idempotent).toBe(true);
    expect(sessions.changed).toBe(0);
    expect(screen.getByText("This one was free.")).toBeTruthy();
    expect(screen.getByTestId("site-logo-cost").textContent).toBe("Each new logo uses AI credits.");
    expect(screen.queryByTestId("site-theme-apply-scope")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/goes live when you publish/);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]!.body).toEqual({ app_id: logoApp, op: { kind: "theme", logo: { preview_id: "p-1" } } });
    expect(sessions.changed).toBe(1);
  });

  it("says which kind of mark the designer chose and why, and shows nothing when the server sent no design", async () => {
    const logoApp = "site:aaaaaaaa-0000-4000-8000-000000000021";
    const designed = {
      status: 200,
      body: { ok: true, preview: { id: "p-9", src: "data:image/svg+xml;base64,PHN2Zy8+", free: true, design: { type: "pictorial", rationale: "Customers already know the bird.", concept: "x" } } },
    };
    const replies = [designed, PREVIEW("p-10", false), { status: 200, body: { ok: true, preview: { id: "p-11", src: "data:image/svg+xml;base64,PHN2Zy8+", free: false, design: { type: 7 } } } }];
    api.answer = (url, body) =>
      url.startsWith("/api/website/site-design-edit?") ? { status: 200, body: state({ logo_ai: true, logo_preview_free: true }) } : isPreview(body) ? replies.shift()! : { status: 200, body: { ok: true } };
    render(<SiteThemePanel appId={logoApp} onClose={() => {}} />);
    await openLogoTab();
    await makeLogo("something with a bird");
    expect((await screen.findByTestId("site-logo-design")).textContent).toBe("Pictorial mark: Customers already know the bird.");
    fireEvent.click(screen.getByRole("button", { name: /Make another/ }));
    await screen.findByText("This one used AI credits.");
    expect(screen.queryByTestId("site-logo-design")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Make another/ }));
    await waitFor(() => expect(api.calls.filter((c) => c.body)).toHaveLength(3));
    expect(screen.queryByTestId("site-logo-design")).toBeNull();
  });

  it("shows under the colour dots whether the next logo is free, and the button is described by that line", async () => {
    const logoApp = "site:aaaaaaaa-0000-4000-8000-000000000022";
    api.answer = (url, body) =>
      url.startsWith("/api/website/site-design-edit?") ? { status: 200, body: state({ logo_ai: true, logo_preview_free: true }) } : isPreview(body) ? PREVIEW("p-1", true) : { status: 200, body: { ok: true } };
    render(<SiteThemePanel appId={logoApp} onClose={() => {}} />);
    await openLogoTab();
    const cost = screen.getByTestId("site-logo-cost");
    expect(cost.textContent).toBe("Your first logo for this site is free.");
    expect(screen.getByRole("button", { name: "Make logo" }).getAttribute("aria-describedby")).toBe(cost.id);
    await makeLogo("a geometric hummingbird");
    expect(screen.getByTestId("site-logo-cost").textContent).toBe("Each new logo uses AI credits.");
    expect(screen.getByRole("button", { name: /Make another/ }).getAttribute("aria-describedby")).toBe(screen.getByTestId("site-logo-cost").id);
  });

  it("Make another replaces the preview, and Apply sends only the one on screen", async () => {
    const logoApp = "site:aaaaaaaa-0000-4000-8000-000000000012";
    const previews = [PREVIEW("p-1", true), PREVIEW("p-2", false)];
    api.answer = (url, body) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state({ logo_ai: true, logo_preview_free: true }) }
        : isPreview(body)
          ? previews.shift()!
          : { status: 200, body: { ok: true, logo: { src: "/images/logo.svg" } } };
    render(<SiteThemePanel appId={logoApp} onClose={() => {}} />);
    await openLogoTab();
    await makeLogo("a geometric hummingbird");
    fireEvent.click(screen.getByRole("button", { name: /Make another/ }));
    await screen.findByText("This one used AI credits.");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/goes live when you publish/);
    const posts = api.calls.filter((call) => call.body);
    expect(posts.map((c) => (c.body as { op: { kind: string } }).op.kind)).toEqual(["logo_preview", "logo_preview", "theme"]);
    expect(posts[2]!.body).toEqual({ app_id: logoApp, op: { kind: "theme", logo: { preview_id: "p-2" } } });
    expect(new Set(posts.map((c) => c.key)).size).toBe(3);
  });

  it("shows a refused preview (e.g. not enough credits) and keeps Apply off", async () => {
    api.answer = (url, body) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state({ logo_ai: true, logo_preview_free: false }) }
        : isPreview(body)
          ? { status: 402, body: { error: { code: "insufficient_credits", message: "Not enough credits for this logo." } } }
          : { status: 200, body: { ok: true } };
    render(<SiteThemePanel appId="site:aaaaaaaa-0000-4000-8000-000000000015" onClose={() => {}} />);
    await openLogoTab();
    expect(screen.getByTestId("site-logo-cost").textContent).toBe("Each new logo uses AI credits.");
    fireEvent.change(screen.getByLabelText("Describe the logo"), { target: { value: "a fox" } });
    fireEvent.click(screen.getByRole("button", { name: "Make logo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Not enough credits");
    expect(screen.queryByAltText("Logo preview")).toBeNull();
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the Logo tab without editable theme tokens", async () => {
    const logoApp = "site:aaaaaaaa-0000-4000-8000-000000000010";
    api.answer = (url) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state({ theme: null, logo_ai: true }) }
        : PREVIEW("p-1", true);
    render(<SiteThemePanel appId={logoApp} onClose={() => {}} />);
    expect(await openLogoTab()).toBeTruthy();
    expect(screen.queryByTestId("site-logo-swatches")).toBeNull();
  });

  it("shows no tabs when AI logos are off", async () => {
    api.answer = () => ({ status: 200, body: state({ logo_ai: false }) });
    render(<SiteThemePanel appId="site:aaaaaaaa-0000-4000-8000-000000000013" onClose={() => {}} />);
    await screen.findByLabelText("Brand colour");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("makes the logo in the unapplied Theme colours, then ONE Apply saves theme and logo; both drafts survive tab switches", async () => {
    const logoApp = "site:aaaaaaaa-0000-4000-8000-000000000011";
    api.answer = (url, body) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state({ logo_ai: true, logo_preview_free: true }) }
        : isPreview(body)
          ? PREVIEW("p-9", true)
          : { status: 200, body: { ok: true, theme: { ...THEME, colors: { ...THEME.colors, primary: "#dc2626" } }, logo: { src: "/images/logo.svg" } } };
    render(<SiteThemePanel appId={logoApp} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Brand colour"), { target: { value: "#dc2626" } });
    expect(screen.getByTestId("site-theme-tab-theme-draft")).toBeTruthy();
    await openLogoTab();
    expect(screen.queryByText(/haven't applied/)).toBeNull();
    const swatches = screen.getByTestId("site-logo-swatches").querySelectorAll("span");
    expect([...swatches].find((s) => s.title === "Brand")!.style.backgroundColor).toBe("rgb(220, 38, 38)");
    await makeLogo("a red geometric fox");
    expect(screen.getByTestId("site-theme-tab-logo-draft")).toBeTruthy();
    expect((api.calls.find((c) => isPreview(c.body))!.body as { op: { colors: unknown } }).op.colors).toEqual({ primary: "#dc2626", accent: "#dbeafe" });
    expect(screen.queryByTestId("site-theme-apply-scope")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Theme/ }));
    expect((screen.getByLabelText("Brand colour") as HTMLInputElement).value).toBe("#dc2626");
    fireEvent.click(screen.getByRole("tab", { name: /Logo/ }));
    expect(screen.getByAltText("Logo preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/goes live when you publish/);
    const applies = api.calls.filter((call) => call.body && !isPreview(call.body));
    expect(applies).toHaveLength(1);
    expect(applies[0]!.body).toEqual({ app_id: logoApp, op: { kind: "theme", colors: { primary: "#dc2626" }, logo: { preview_id: "p-9" } } });
  });

  it("Reset on the Logo tab clears only the logo draft and its preview", async () => {
    api.answer = (url, body) =>
      url.startsWith("/api/website/site-design-edit?") ? { status: 200, body: state({ logo_ai: true, logo_preview_free: true }) } : isPreview(body) ? PREVIEW("p-1", true) : { status: 200, body: {} };
    render(<SiteThemePanel appId="site:aaaaaaaa-0000-4000-8000-000000000014" onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Brand colour"), { target: { value: "#dc2626" } });
    await openLogoTab();
    await makeLogo("a red geometric fox");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect((screen.getByLabelText("Describe the logo") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByAltText("Logo preview")).toBeNull();
    expect(screen.queryByTestId("site-theme-apply-scope")).toBeNull();
  });
});

const sectionEl: SelectedElement = { selector: "main > section:nth-of-type(2) h2", tag: "h2", text: "Our services", textEditable: true, style: {}, section: "services" };
const photoEl: SelectedElement = { selector: "main img", tag: "img", text: "", textEditable: true, style: {}, attrs: { src: "/images/hero-1600.webp" }, section: "hero" };

describe("SiteElementDesignControls", () => {
  it("changes a section's layout and moves it, with the path of the viewed page", async () => {
    api.answer = (url) =>
      url.startsWith("/api/website/site-design-edit?") ? { status: 200, body: state({ section: SECTION }) } : { status: 200, body: { ok: true, section: { ...SECTION, variant: "alternating" } } };
    render(<SiteElementDesignControls appId={APP} path="/services" selected={sectionEl} />);
    const layout = await screen.findByLabelText("Section layout");
    expect(api.calls[0]!.url).toContain("section=services");
    expect(api.calls[0]!.url).toContain("path=%2Fservices");
    expect((screen.getByLabelText("Move section down") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(layout, { target: { value: "alternating" } });
    await screen.findByText(/goes live when you publish/);
    expect(api.calls[1]!.body).toEqual({ app_id: APP, op: { kind: "section", section_id: "services", variant: "alternating" }, path: "/services" });
    fireEvent.click(screen.getByLabelText("Move section up"));
    await waitFor(() => expect(api.calls[2]?.body).toMatchObject({ op: { kind: "section", section_id: "services", move: "up" } }));
  });

  it("hands a section change to the parent, which clears the stale selection", async () => {
    api.answer = (url) =>
      url.startsWith("/api/website/site-design-edit?") ? { status: 200, body: state({ section: SECTION }) } : { status: 200, body: { ok: true, section: SECTION } };
    const changed = vi.fn();
    render(<SiteElementDesignControls appId={APP} path="/" selected={sectionEl} onSectionChanged={changed} />);
    fireEvent.click(await screen.findByLabelText("Move section up"));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.stringContaining("goes live when you publish")));
  });

  it("names the new photo on the next swap", async () => {
    let n = 0;
    api.answer = (url) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state() }
        : { status: 200, body: { ok: true, image: { src: `/images/hero-${(n += 1) + 1}-1600.webp`, srcset: "", places: 1 } } };
    render(<SiteElementDesignControls appId={APP} path="/" selected={photoEl} />);
    const link = await screen.findByLabelText("Photo address");
    fireEvent.change(link, { target: { value: "https://photos.example/a.jpg" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    await screen.findByText(/goes live when you publish/);
    fireEvent.change(link, { target: { value: "https://photos.example/b.jpg" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    await waitFor(() => expect(api.calls.filter((c) => c.body)).toHaveLength(2));
    expect(api.calls.filter((c) => c.body)[1]!.body).toMatchObject({ op: { src: "/images/hero-2-1600.webp" } });
  });

  it("shows why a section can't be changed", async () => {
    api.answer = () => ({ status: 200, body: state({ section_message: "This part of the page can't be rearranged here. Ask for the change in the chat." }) });
    render(<SiteElementDesignControls appId={APP} path="/" selected={sectionEl} />);
    await screen.findByText(/can't be rearranged here/);
  });

  it("offers AI photo actions only when they are on, and swaps from a link", async () => {
    api.answer = (url) =>
      url.startsWith("/api/website/site-design-edit?") ? { status: 200, body: state() } : { status: 200, body: { ok: true, image: { src: "/images/hero-2-1600.webp", srcset: "", places: 2 } } };
    render(<SiteElementDesignControls appId={APP} path="/" selected={photoEl} />);
    const link = await screen.findByLabelText("Photo address");
    expect(screen.queryByText("New photo")).toBeNull();
    fireEvent.change(link, { target: { value: "https://photos.example/van.jpg" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this photo" }));
    await screen.findByText(/Swapped in 2 places/);
    expect(api.calls.find((c) => c.body)!.body).toMatchObject({ op: { kind: "image", src: "/images/hero-1600.webp", mode: "url", text: "https://photos.example/van.jpg" } });
  });

  it("generates or edits with a description when AI photos are on", async () => {
    api.answer = (url) =>
      url.startsWith("/api/website/site-design-edit?")
        ? { status: 200, body: state({ image_ai: true }) }
        : { status: 402, body: { error: { code: "insufficient_credits", message: "Not enough credits for this photo." } } };
    render(<SiteElementDesignControls appId={APP} path="/" selected={photoEl} />);
    fireEvent.change(await screen.findByLabelText("Describe the photo"), { target: { value: "make it a sunny morning" } });
    fireEvent.click(screen.getByRole("button", { name: "Change this photo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Not enough credits for this photo.");
    expect(screen.getByText(/AI photos use credits/)).toBeTruthy();
    expect(api.calls.find((c) => c.body)!.body).toMatchObject({ op: { mode: "edit", text: "make it a sunny morning" } });
  });

  it("renders nothing for a plain element outside any section", () => {
    const { container } = render(<SiteElementDesignControls appId={APP} path="/" selected={{ ...sectionEl, section: undefined }} />);
    expect(container.innerHTML).toBe("");
    expect(isSitePhoto({ tag: "img", attrs: { src: "https://cdn.example/a.png" } })).toBe(false);
  });
});

describe("editor protocol: section", () => {
  it("keeps a valid section id and drops anything else", () => {
    const base = { type: EDITOR_SELECTED_TYPE, selector: "main h1", tag: "H1", style: {} };
    expect(parseEditorSelected({ ...base, section: "hero" }, "https://a.example", "https://a.example")?.section).toBe("hero");
    expect(parseEditorSelected({ ...base, section: "<img onerror>" }, "https://a.example", "https://a.example")?.section).toBeUndefined();
  });
});
