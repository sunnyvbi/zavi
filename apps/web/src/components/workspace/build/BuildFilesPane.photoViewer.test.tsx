// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Reply = { status: number; body?: unknown };
type Call = { key: string; body: unknown };
const net = vi.hoisted(() => ({
  pending: [] as Array<Call & { resolve: (r: Reply) => void }>,
  calls: [] as Call[],
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts: { method?: string; body?: unknown } = {}) => {
    const call = { key: `${opts.method ?? "GET"} ${path}`, body: opts.body };
    net.calls.push(call);
    return new Promise((resolve) => {
      net.pending.push({
        ...call,
        resolve: (r: Reply) =>
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            json: async () => {
              if (r.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
              return r.body;
            },
          }),
      });
    });
  },
}));

import { BuildFilesPane } from "./BuildFilesPane";

const GET = "GET /api/workspace/files";

async function reply(key: string, r: Reply) {
  const target = net.pending.find((p) => p.key === key);
  if (!target) {
    throw new Error(`no pending ${key}; pending: ${net.pending.map((p) => p.key).join(", ") || "none"}`);
  }
  net.pending.splice(net.pending.indexOf(target), 1);
  await act(async () => {
    target.resolve(r);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const photo = (id: string, created_at: string, collection_ids: string[] = []) => ({
  id,
  name: `${id}.png`,
  mime: "image/png",
  size: 2048,
  url: `https://cdn.test/${id}.png`,
  created_at,
  collection_ids,
});

const FILES = [
  photo("oldest", "2026-09-01T10:00:00.000Z"),
  photo("newest", "2026-09-20T10:00:00.000Z"),
  { ...photo("brief", "2026-09-15T10:00:00.000Z"), name: "brief.pdf", mime: "application/pdf" },
  photo("middle", "2026-09-10T10:00:00.000Z"),
];

const LANDING = { id: "c1", name: "landing", created_at: "2026-09-19T10:00:00.000Z", file_count: 0 };

async function mount(files: unknown[] = FILES, collections: unknown[] = [LANDING]) {
  const onUseOnSite = vi.fn();
  render(<BuildFilesPane onUseOnSite={onUseOnSite} />);
  await reply(GET, { status: 200, body: { files, collections } });
  return { onUseOnSite };
}

const viewer = () => screen.getByTestId("photo-viewer");
const shownName = () => within(viewer()).getByRole("img").getAttribute("alt");
const key = (k: string, target: Node = document.body) => {
  fireEvent.keyDown(target, { key: k });
};

function openPhoto(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Open ${name}` }));
}

function loadNatural(img: HTMLElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(img);
}

afterEach(() => {
  cleanup();
  net.pending.length = 0;
  net.calls.length = 0;
  vi.restoreAllMocks();
});

describe("Files photo viewer", () => {
  it("opens the clicked photo in the pane with the breadcrumb, and only images get an open target", async () => {
    await mount();
    expect(screen.queryByTestId("photo-viewer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open brief.pdf" })).toBeNull();

    openPhoto("middle.png");

    const crumb = within(viewer()).getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByRole("button", { name: "Files" })).toBeTruthy();
    expect(within(crumb).getByText("middle.png").getAttribute("aria-current")).toBe("page");
    const img = within(viewer()).getByRole("img", { name: "middle.png" });
    expect(img.getAttribute("src")).toBe("https://cdn.test/middle.png");
    expect(screen.queryByRole("list", { name: "Photos" })).toBeNull();
    expect(document.activeElement).toBe(within(viewer()).getByRole("button", { name: "Back to files" }));
  });

  it("closes from the back chevron and the Files crumb, handing focus back to the photo it came from", async () => {
    await mount();
    openPhoto("middle.png");
    key("ArrowRight");
    expect(shownName()).toBe("oldest.png");

    fireEvent.click(within(viewer()).getByRole("button", { name: "Back to files" }));
    expect(screen.queryByTestId("photo-viewer")).toBeNull();
    expect(screen.getByRole("list", { name: "Photos" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open oldest.png" })),
    );

    openPhoto("newest.png");
    fireEvent.click(within(viewer()).getByRole("button", { name: "Files" }));
    expect(screen.queryByTestId("photo-viewer")).toBeNull();
  });

  it("closes on Escape, but Escape inside an open menu, dialog or details popover closes only that", async () => {
    await mount();
    openPhoto("newest.png");

    fireEvent.click(within(viewer()).getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu", { name: "More actions" })).toBeTruthy();
    key("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("photo-viewer")).toBeTruthy();

    fireEvent.click(within(viewer()).getByRole("button", { name: "Add to collections" }));
    expect(screen.getByRole("dialog", { name: "Add to collection" })).toBeTruthy();
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("photo-viewer")).toBeTruthy();

    fireEvent.click(within(viewer()).getByRole("button", { name: "File details" }));
    expect(within(viewer()).getByRole("group", { name: "File details" })).toBeTruthy();
    key("Escape");
    expect(within(viewer()).queryByRole("group", { name: "File details" })).toBeNull();
    expect(screen.getByTestId("photo-viewer")).toBeTruthy();

    key("Escape");
    expect(screen.queryByTestId("photo-viewer")).toBeNull();
  });

  it("walks the photos in list order with the arrow keys, skipping non-images and stopping at the ends", async () => {
    await mount();
    openPhoto("newest.png");
    expect(within(viewer()).getByText("1 of 3")).toBeTruthy();

    key("ArrowLeft");
    expect(shownName()).toBe("newest.png");
    key("ArrowRight");
    expect(shownName()).toBe("middle.png");
    expect(within(viewer()).getByText("2 of 3")).toBeTruthy();
    key("ArrowRight");
    expect(shownName()).toBe("oldest.png");
    key("ArrowRight");
    expect(shownName()).toBe("oldest.png");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(shownName()).toBe("newest.png");

    fireEvent.click(within(viewer()).getByRole("button", { name: "Add to collections" }));
    key("ArrowRight");
    expect(shownName()).toBe("newest.png");
  });

  it("follows the list's sort and collection scope, not the raw upload order", async () => {
    await mount([...FILES.slice(0, 2), photo("tagged", "2026-09-05T10:00:00.000Z", ["c1"])], [
      { ...LANDING, file_count: 1 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Newest first" }));
    openPhoto("oldest.png");
    key("ArrowRight");
    expect(shownName()).toBe("tagged.png");
    key("ArrowRight");
    expect(shownName()).toBe("newest.png");
  });

  it("adds the open photo to a collection through the existing collection call and stays open", async () => {
    await mount();
    openPhoto("middle.png");
    fireEvent.click(within(viewer()).getByRole("button", { name: "Add to collections" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /landing/ }));

    const post = net.calls.filter((c) => c.key === "POST /api/workspace/file-collections/c1/files");
    expect(post).toHaveLength(1);
    expect(JSON.parse(post[0]!.body as string)).toEqual({ file_ids: ["middle"] });
    await reply("POST /api/workspace/file-collections/c1/files", { status: 200, body: {} });

    expect(screen.getByTestId("photo-viewer")).toBeTruthy();
    expect(shownName()).toBe("middle.png");
    expect(within(viewer()).getByRole("status").textContent).toContain('Added to "landing"');
  });

  it("can start a new collection from the viewer and puts the photo in it", async () => {
    await mount();
    openPhoto("oldest.png");
    fireEvent.click(within(viewer()).getByRole("button", { name: "Add to collections" }));
    fireEvent.click(screen.getByRole("button", { name: "New collection…" }));
    fireEvent.change(screen.getByLabelText("Collection name"), { target: { value: "hero" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await reply("POST /api/workspace/file-collections", {
      status: 200,
      body: { collection: { id: "c2", name: "hero", created_at: "2026-09-21T10:00:00.000Z", file_count: 0 } },
    });
    const add = net.calls.find((c) => c.key === "POST /api/workspace/file-collections/c2/files");
    expect(add && JSON.parse(add.body as string)).toEqual({ file_ids: ["oldest"] });
    expect(screen.getByTestId("photo-viewer")).toBeTruthy();
  });

  it("the photo bar offers only Add to collections: no Edit and no Add to chat", async () => {
    await mount();
    openPhoto("newest.png");
    const toolbar = within(viewer()).getByRole("toolbar", { name: "Photo actions" });
    expect(within(toolbar).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Add to collections"]);
    expect(within(toolbar).queryByRole("button", { name: /edit/i })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: /chat/i })).toBeNull();
  });

  it("scales the photo from the Fit menu to its real 100% and 200% size, and back to fit", async () => {
    await mount();
    openPhoto("newest.png");
    const img = within(viewer()).getByRole("img");
    loadNatural(img, 400, 300);
    const zoomButton = within(viewer()).getByRole("button", { name: "Zoom: Fit" });
    expect(img.style.width).toBe("");
    expect(img.className).toContain("max-w-full");

    fireEvent.click(zoomButton);
    const menu = within(viewer()).getByRole("menu", { name: "Zoom" });
    expect(within(menu).getByRole("menuitemradio", { name: "Fit" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "100%" }));
    expect(img.style.width).toBe("400px");
    expect(img.style.height).toBe("300px");
    expect(img.className).not.toContain("max-w-full");
    expect(within(viewer()).getByRole("button", { name: "Zoom: 100%" })).toBeTruthy();

    fireEvent.click(within(viewer()).getByRole("button", { name: "Zoom: 100%" }));
    fireEvent.click(within(viewer()).getByRole("menuitemradio", { name: "200%" }));
    expect(img.style.width).toBe("800px");
    expect(img.style.height).toBe("600px");

    fireEvent.click(within(viewer()).getByRole("button", { name: "Zoom: 200%" }));
    fireEvent.click(within(viewer()).getByRole("menuitemradio", { name: "Fit" }));
    expect(img.style.width).toBe("");
    expect(img.className).toContain("max-w-full");
  });

  it("drops back to Fit when moving to another photo, and Escape in the Fit menu keeps the viewer", async () => {
    await mount();
    openPhoto("newest.png");
    loadNatural(within(viewer()).getByRole("img"), 400, 300);
    fireEvent.click(within(viewer()).getByRole("button", { name: "Zoom: Fit" }));
    fireEvent.click(within(viewer()).getByRole("menuitemradio", { name: "200%" }));

    key("ArrowRight");
    expect(shownName()).toBe("middle.png");
    expect(within(viewer()).getByRole("button", { name: "Zoom: Fit" })).toBeTruthy();
    expect(within(viewer()).getByRole("img").style.width).toBe("");

    fireEvent.click(within(viewer()).getByRole("button", { name: "Zoom: Fit" }));
    key("Escape");
    expect(within(viewer()).queryByRole("menu", { name: "Zoom" })).toBeNull();
    expect(shownName()).toBe("middle.png");
  });

  it("lists name, size, type, added date and, once loaded, the dimensions in the details popover", async () => {
    await mount();
    openPhoto("middle.png");
    fireEvent.click(within(viewer()).getByRole("button", { name: "File details" }));
    const details = within(viewer()).getByRole("group", { name: "File details" });
    const pairs = () =>
      Array.from(details.querySelectorAll("dt")).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(pairs()).toEqual([
      ["Name", "middle.png"],
      ["Size", "2 KB"],
      ["Type", "PNG"],
      ["Added", expect.stringMatching(/Sep/)],
    ]);
    loadNatural(within(viewer()).getByRole("img"), 1600, 900);
    expect(pairs()).toContainEqual(["Dimensions", "1600 × 900"]);
  });

  it("links Download straight to the photo file under its own name", async () => {
    await mount();
    openPhoto("middle.png");
    const link = within(viewer()).getByRole("link", { name: "Download" });
    expect(link.getAttribute("href")).toBe("https://cdn.test/middle.png");
    expect(link.getAttribute("download")).toBe("middle.png");
    key("ArrowRight");
    expect(within(viewer()).getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      "https://cdn.test/oldest.png",
    );
  });

  it("deleting from the more menu moves to the next photo, and the last one closes the viewer", async () => {
    await mount([FILES[1], FILES[3]], []);
    openPhoto("newest.png");
    fireEvent.click(within(viewer()).getByRole("button", { name: "More actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(net.calls.some((c) => c.key === "DELETE /api/workspace/files/newest")).toBe(true);
    await waitFor(() => expect(shownName()).toBe("middle.png"));
    await reply("DELETE /api/workspace/files/newest", { status: 204 });

    fireEvent.click(within(viewer()).getByRole("button", { name: "More actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByTestId("photo-viewer")).toBeNull());
  });

  it("acts on the open photo alone from the more menu even while other photos are selected", async () => {
    const { onUseOnSite } = await mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select newest.png" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select middle.png" }));
    openPhoto("newest.png");
    expect(screen.queryByRole("toolbar", { name: "Selected photos" })).toBeNull();
    fireEvent.click(within(viewer()).getByRole("button", { name: "More actions" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Use on site" }));
    expect(onUseOnSite).toHaveBeenCalledWith([{ name: "newest.png", url: "https://cdn.test/newest.png" }]);
    key("Escape");
    expect(screen.queryByTestId("photo-viewer")).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Selected photos" })).toBeTruthy();
  });

  it("leaving the Files pane closes the viewer, so its keys never act on a hidden photo", async () => {
    const view = render(<BuildFilesPane onUseOnSite={vi.fn()} active />);
    await reply(GET, { status: 200, body: { files: FILES, collections: [LANDING] } });
    openPhoto("middle.png");
    expect(viewer()).toBeTruthy();
    view.rerender(<BuildFilesPane onUseOnSite={vi.fn()} active={false} />);
    expect(screen.queryByTestId("photo-viewer")).toBeNull();
    key("ArrowRight");
    key("Escape");
    view.rerender(<BuildFilesPane onUseOnSite={vi.fn()} active />);
    expect(screen.queryByTestId("photo-viewer")).toBeNull();
    expect(screen.getByRole("list", { name: "Photos" })).toBeTruthy();
  });

  it("makes everything behind the viewer inert, so Tab never reaches hidden controls", async () => {
    await mount();
    const search = screen.getByRole("searchbox", { hidden: true }) ?? screen.getByLabelText("Search files and collections");
    openPhoto("middle.png");
    const hidden = Array.from(document.querySelectorAll('[aria-hidden="true"]')).filter((el) => el.contains(search) || el.querySelector('[aria-label="Photos"]'));
    expect(hidden.length).toBeGreaterThanOrEqual(1);
    for (const el of hidden) expect(el.hasAttribute("inert")).toBe(true);
    expect(search.closest("[inert]")).not.toBeNull();
    fireEvent.click(within(viewer()).getByRole("button", { name: "Back to files" }));
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("ignores arrow keys typed into a field", async () => {
    await mount();
    openPhoto("newest.png");
    const field = document.createElement("input");
    document.body.appendChild(field);
    key("ArrowRight", field);
    key("Escape", field);
    expect(shownName()).toBe("newest.png");
    field.remove();
  });

  it("uses only theme tokens or hex classes that workspace-dark.css remaps", async () => {
    const dark = readFileSync(join(__dirname, "../../../app/workspace-dark.css"), "utf8");
    await mount();
    openPhoto("newest.png");
    fireEvent.click(within(viewer()).getByRole("button", { name: "File details" }));
    fireEvent.click(within(viewer()).getByRole("button", { name: "Zoom: Fit" }));
    const classes = new Set<string>();
    for (const el of [viewer(), ...Array.from(viewer().querySelectorAll("*"))]) {
      for (const cls of (el.getAttribute("class") ?? "").split(/\s+/)) if (cls) classes.add(cls);
    }
    expect(classes.has("bg-cream")).toBe(true);
    expect(classes.has("text-ink")).toBe(true);
    expect(classes.has("border-rule")).toBe(true);
    const hex = [...classes].filter((cls) => /\[#[0-9a-fA-F]{3,8}\]/.test(cls));
    const escape = (cls: string) => cls.replace(/[[\]#:/.()%]/g, (ch) => `\\${ch}`);
    const missing = hex.filter((cls) => !dark.includes(`.workspace-shell .${escape(cls)}`));
    expect(missing).toEqual([]);
    const inline = Array.from(viewer().querySelectorAll<HTMLElement>("[style]")).map((el) => el.getAttribute("style"));
    expect(inline.filter((style) => /#[0-9a-fA-F]{3,8}\b|rgb\(/.test(style ?? ""))).toEqual([]);
  });
});
