// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

import { BuildFilesPane, formatFileDate } from "./BuildFilesPane";
import tailwindConfig from "../../../../tailwind.config";

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

const photo = (id: string, collection_ids: string[] = [], created_at = "2026-09-20T10:00:00.000Z") => ({
  id,
  name: `${id}.png`,
  mime: "image/png",
  size: 2048,
  url: `https://cdn.test/${id}.png`,
  created_at,
  collection_ids,
});

const fileOf = (id: string, name: string, mime: string, collection_ids: string[] = []) => ({
  ...photo(id, collection_ids),
  name,
  mime,
  url: `https://cdn.test/${name}`,
});

const landing = (file_count: number) => ({
  id: "c1",
  name: "landing",
  created_at: "2026-09-19T10:00:00.000Z",
  file_count,
});

function upload(name: string, type: string, size = 1024): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

async function open(body: { files: unknown[]; collections: unknown[] }) {
  const onUseOnSite = vi.fn();
  const view = render(<BuildFilesPane onUseOnSite={onUseOnSite} />);
  await reply(GET, { status: 200, body });
  return { ...view, onUseOnSite };
}

const writes = () => net.calls.filter((c) => !c.key.startsWith("GET "));

function pick(files: File[]) {
  const input = screen.getByTestId("files-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  fireEvent.change(input);
}

function chooseAction(fileName: string, action: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${fileName}` }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: action }));
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  net.pending.length = 0;
  net.calls.length = 0;
  vi.restoreAllMocks();
});

describe("formatFileDate", () => {
  const now = new Date(2026, 8, 24, 0, 5);
  it("names today and yesterday by calendar day, not by 24 hours", () => {
    expect(formatFileDate(new Date(2026, 8, 24, 0, 1).toISOString(), now)).toBe("Today");
    expect(formatFileDate(new Date(2026, 8, 23, 23, 59).toISOString(), now)).toBe("Yesterday");
    expect(formatFileDate(new Date(2026, 8, 23, 0, 6).toISOString(), now)).toBe("Yesterday");
  });

  it("drops the year only within the current year, and blanks a bad date", () => {
    const same = formatFileDate(new Date(2026, 8, 20, 12).toISOString(), now);
    const older = formatFileDate(new Date(2025, 8, 20, 12).toISOString(), now);
    expect(same).not.toMatch(/2026/);
    expect(same).toMatch(/20/);
    expect(older).toMatch(/2025/);
    expect(formatFileDate("not a date", now)).toBe("");
  });
});

describe("BuildFilesPane", () => {
  it("shows a skeleton while loading, then the centred first-run screen with both actions", async () => {
    render(<BuildFilesPane onUseOnSite={vi.fn()} />);
    expect(screen.getByText("Loading files")).toBeTruthy();
    await reply(GET, { status: 200, body: { files: [], collections: [] } });
    expect(screen.queryByText("Loading files")).toBeNull();

    expect(screen.getByText("No files or collections")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Collections" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Filter by type" })).toBeNull();
    const uploadButton = screen.getByRole("button", { name: "Upload files" }) as HTMLButtonElement;
    expect(uploadButton.disabled).toBe(false);
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(uploadButton);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Create collection" }));
    expect(screen.getByRole("dialog", { name: "Create collection" })).toBeTruthy();
  });

  it("offers Try again when the list fails, and it refetches", async () => {
    render(<BuildFilesPane onUseOnSite={vi.fn()} />);
    await reply(GET, { status: 500, body: { error: { code: "internal", message: "Storage is down" } } });
    expect(screen.getByRole("alert").textContent).toContain("Storage is down");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(net.calls.filter((c) => c.key === GET)).toHaveLength(2);
    await reply(GET, { status: 200, body: { files: [photo("hero")], collections: [] } });
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "hero.png" }).getAttribute("aria-description")).toBe(
      "Uploaded image asset. File name: hero.png",
    );
  });

  it("shows the first-run screen with actions disabled while Files is not set up", async () => {
    const { container } = render(<BuildFilesPane onUseOnSite={vi.fn()} />);
    await reply(GET, {
      status: 503,
      body: { error: { code: "files_not_ready", message: "Files is not set up in this environment yet." } },
    });
    expect(screen.getByText("No files or collections")).toBeTruthy();
    expect(screen.getByText("Uploads switch on with the next release.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Couldn.t load your files/)).toBeNull();
    expect((screen.getByRole("button", { name: "Upload files" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create collection" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    for (const item of screen.getAllByRole("menuitem")) {
      expect((item as HTMLButtonElement).disabled).toBe(true);
    }
    const drop = container.firstElementChild as HTMLElement;
    fireEvent.drop(drop, { dataTransfer: { types: ["Files"], files: [upload("hero.png", "image/png")] } });
    expect(writes()).toEqual([]);
  });

  it("rejects an svg and a 12 MB file before any upload and names both", async () => {
    await open({ files: [], collections: [] });
    pick([upload("logo.svg", "image/svg+xml"), upload("huge.png", "image/png", 12 * 1024 * 1024)]);
    expect(writes()).toEqual([]);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("2 files weren't uploaded");
    expect(alert.textContent).toContain("logo.svg: Not a PNG, JPEG, WebP, GIF or AVIF image");
    expect(alert.textContent).toContain("huge.png: Larger than 10 MB");
  });

  it("uploads the good files from a mixed pick and still reports the skipped one", async () => {
    await open({ files: [], collections: [] });
    pick([upload("hero.png", "image/png"), upload("logo.svg", "image/svg+xml")]);
    const posts = writes();
    expect(posts.map((c) => c.key)).toEqual(["POST /api/workspace/files"]);
    expect(((posts[0]!.body as FormData).getAll("files") as File[]).map((f) => f.name)).toEqual(["hero.png"]);
    expect(screen.getByRole("alert").textContent).toContain("logo.svg");
    expect(screen.getByText("Uploading…")).toBeTruthy();

    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("hero")] } });
    expect(screen.queryByText("Uploading…")).toBeNull();
    expect(screen.getByRole("img", { name: "hero.png" }).getAttribute("loading")).toBe("lazy");
  });

  it("drops files into the selected collection and sends its id", async () => {
    await open({ files: [photo("old")], collections: [landing(0)] });
    fireEvent.click(screen.getByRole("button", { name: /^landing/ }));
    expect(screen.getByText("No matching files")).toBeTruthy();

    const target = screen.getByText("No matching files");
    const dataTransfer = { types: ["Files"], files: [upload("hero.png", "image/png")], dropEffect: "none" };
    fireEvent.dragEnter(target, { dataTransfer });
    expect(screen.getByText('Drop photos to add them to "landing"')).toBeTruthy();
    fireEvent.drop(target, { dataTransfer });
    expect(screen.queryByText('Drop photos to add them to "landing"')).toBeNull();

    const post = writes().find((c) => c.key === "POST /api/workspace/files")!;
    expect((post.body as FormData).get("collection_id")).toBe("c1");
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("hero", ["c1"])] } });
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "old.png" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("1 photo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collections" }));
    expect(screen.getByRole("button", { name: /^landing/ }).textContent).toContain("1 photo");
  });

  it("shows a failed upload's reason on its card and lets it be dismissed", async () => {
    await open({ files: [photo("old")], collections: [] });
    pick([upload("big.png", "image/png")]);
    await reply("POST /api/workspace/files", {
      status: 413,
      body: { error: { code: "too_large", message: "big.png is over the 10 MB limit." } },
    });
    expect(screen.getByText("big.png is over the 10 MB limit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss big.png" }));
    expect(screen.queryByText("big.png is over the 10 MB limit.")).toBeNull();
  });

  it("hides a deleted photo at once and brings it back with the reason when the server fails", async () => {
    await open({ files: [photo("hero"), photo("team")], collections: [] });
    chooseAction("hero.png", "Delete");
    const dialog = screen.getByRole("dialog", { name: "Delete this photo?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(screen.queryByRole("img", { name: "hero.png" })).toBeNull();
    expect(writes().map((c) => c.key)).toEqual(["DELETE /api/workspace/files/hero"]);

    await reply("DELETE /api/workspace/files/hero", {
      status: 500,
      body: { error: { code: "internal", message: "Storage is down" } },
    });
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Storage is down");
  });

  it("does not delete anything when the confirm is cancelled", async () => {
    await open({ files: [photo("hero")], collections: [] });
    chooseAction("hero.png", "Delete");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes()).toEqual([]);
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
  });

  it("deletes a collection but keeps its photos in All files", async () => {
    await open({ files: [photo("hero", ["c1"]), photo("team")], collections: [landing(1)] });
    fireEvent.click(screen.getByRole("button", { name: /^landing/ }));
    expect(screen.queryByRole("img", { name: "team.png" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collection actions for landing" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete collection" }));
    const dialog = screen.getByRole("dialog", { name: 'Delete "landing"?' });
    expect(dialog.textContent).toContain("Photos stay in All files.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete collection" }));

    expect(screen.queryByRole("button", { name: /^landing/ })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(screen.getByRole("region", { name: "Collections" })).toBeTruthy();
    await reply("DELETE /api/workspace/file-collections/c1", { status: 204 });
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "team.png" })).toBeTruthy();
    expect(writes().map((c) => c.key)).toEqual(["DELETE /api/workspace/file-collections/c1"]);
  });

  it("puts a photo's exact url into the chat without sending anything", async () => {
    const { onUseOnSite } = await open({ files: [photo("hero"), photo("team")], collections: [] });
    chooseAction("team.png", "Use on site");
    expect(onUseOnSite).toHaveBeenCalledTimes(1);
    expect(onUseOnSite).toHaveBeenCalledWith([{ name: "team.png", url: "https://cdn.test/team.png" }]);
    expect(writes()).toEqual([]);
  });

  it("uses a whole collection on the site, not just the photos the search shows", async () => {
    const { onUseOnSite } = await open({
      files: [photo("hero", ["c1"]), photo("team", ["c1"]), photo("other")],
      collections: [landing(2)],
    });
    fireEvent.click(screen.getByRole("button", { name: /^landing/ }));
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "team" } });
    expect(screen.queryByRole("img", { name: "hero.png" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use on site" }));
    expect(onUseOnSite).toHaveBeenCalledWith([{ name: "hero.png", url: "https://cdn.test/hero.png" }, { name: "team.png", url: "https://cdn.test/team.png" }]);
    expect(writes()).toEqual([]);
  });

  it("floats the selection actions in one bar, and a selected card's menu acts on the selection too", async () => {
    const { onUseOnSite } = await open({
      files: [photo("a"), photo("b"), photo("c")],
      collections: [],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select c.png" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select a.png" }));
    const bar = screen.getByRole("toolbar", { name: "Selected photos" });
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Clear selection",
      "Select all",
      "Add to collection",
      "Use on site",
      "Delete 2 photos",
    ]);
    expect(within(bar).getByRole("button", { name: "Clear selection" }).textContent).toBe("2 selected");
    expect(screen.getByRole("button", { name: "Select files" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Actions for b.png" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Use on site",
      "Copy link",
      "Add to collection",
      "Delete",
    ]);
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Actions for c.png" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Use 2 photos on site",
      "Add 2 photos to collection",
      "Delete 2 photos",
    ]);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Use 2 photos on site" }));
    expect(onUseOnSite).toHaveBeenCalledTimes(1);
    expect(onUseOnSite).toHaveBeenCalledWith([{ name: "a.png", url: "https://cdn.test/a.png" }, { name: "c.png", url: "https://cdn.test/c.png" }]);
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected photos" })).getByRole("button", { name: "Use on site" }));
    expect(onUseOnSite).toHaveBeenCalledTimes(2);
    expect(onUseOnSite).toHaveBeenLastCalledWith([{ name: "a.png", url: "https://cdn.test/a.png" }, { name: "c.png", url: "https://cdn.test/c.png" }]);
    expect(writes()).toEqual([]);

    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected photos" })).getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getAllByRole("checkbox").filter((b) => (b as HTMLInputElement).checked)).toEqual([]);
  });

  it("selects every visible photo from the bar, and Esc clears only once no menu is open", async () => {
    await open({ files: [photo("a"), photo("b"), photo("c")], collections: [] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select b.png" }));
    const bar = () => screen.getByRole("toolbar", { name: "Selected photos" });
    fireEvent.click(within(bar()).getByRole("button", { name: "Select all" }));
    expect(bar().textContent).toContain("3 selected");
    expect(within(bar()).queryByRole("button", { name: "Select all" })).toBeNull();
    expect(screen.getAllByRole("checkbox").every((b) => (b as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Actions for a.png" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(bar().textContent).toContain("3 selected");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getAllByRole("checkbox").some((b) => (b as HTMLInputElement).checked)).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("keeps the selection when Esc closes a dialog opened from the bar", async () => {
    await open({ files: [photo("a"), photo("b")], collections: [landing(0)] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select a.png" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select b.png" }));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected photos" })).getByRole("button", { name: "Delete 2 photos" }));
    expect(screen.getByRole("dialog", { name: "Delete 2 photos?" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Selected photos" }).textContent).toContain("2 selected");
    expect(writes()).toEqual([]);
  });

  it("adds the selected photos to a collection in one request", async () => {
    await open({ files: [photo("a"), photo("b")], collections: [landing(0)] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select a.png" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select b.png" }));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected photos" })).getByRole("button", { name: "Add to collection" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /landing/ }));
    const post = writes()[0]!;
    expect(post.key).toBe("POST /api/workspace/file-collections/c1/files");
    expect(JSON.parse(post.body as string)).toEqual({ file_ids: ["a", "b"] });
    expect(screen.getByRole("button", { name: /^landing/ }).textContent).toContain("2 photos");
  });

  it("filters photos and collections by name", async () => {
    await open({
      files: [photo("hero"), photo("team")],
      collections: [landing(0), { id: "c2", name: "about", created_at: "", file_count: 0 }],
    });
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "HER" } });
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "team.png" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "abo" } });
    expect(screen.getByRole("button", { name: /^about/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^landing/ })).toBeNull();
    expect(screen.getByText("No matching files")).toBeTruthy();
  });

  it("insets menu rows so the hover chip keeps rounded corners inside the rounded surface", async () => {
    await open({ files: [photo("hero")], collections: [] });
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const menu = screen.getByRole("menu", { name: "New" });
    const surface = menu.className.split(" ");
    expect(surface).toContain("rounded-xl");
    expect(surface).toContain("p-1");
    expect(surface).not.toContain("py-1");
    for (const row of within(menu).getAllByRole("menuitem")) {
      expect(row.className.split(" ")).toContain("rounded-lg");
    }
  });

  it("closes the New menu on Escape and on a click outside", async () => {
    await open({ files: [photo("hero")], collections: [] });
    const trigger = screen.getByRole("button", { name: "New" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "New" });
    expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Upload files",
      "Create collection",
    ]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Upload files" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("creates a collection: focuses the name, validates it, and shows the 409 message", async () => {
    await open({ files: [photo("hero")], collections: [landing(0)] });
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create collection" }));
    const dialog = screen.getByRole("dialog", { name: "Create collection" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const input = within(dialog).getByRole("textbox", { name: "Collection name" });
    expect(document.activeElement).toBe(input);

    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(within(dialog).getByRole("alert").textContent).toBe("Give the collection a name.");
    fireEvent.change(input, { target: { value: "x".repeat(61) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(within(dialog).getByRole("alert").textContent).toBe("Keep the name to 60 characters or fewer.");
    expect(writes()).toEqual([]);

    fireEvent.change(input, { target: { value: "landing" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await reply("POST /api/workspace/file-collections", {
      status: 409,
      body: { error: { code: "collection_exists", message: "You already have a collection called landing." } },
    });
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe(
      "You already have a collection called landing.",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a new collection after creating it so the next upload lands there", async () => {
    await open({ files: [photo("hero")], collections: [] });
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create collection" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Collection name" }), { target: { value: "landing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await reply("POST /api/workspace/file-collections", { status: 201, body: { collection: landing(0) } });
    expect(screen.queryByRole("dialog")).toBeNull();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByText("landing").getAttribute("aria-current")).toBe("page");

    pick([upload("new.png", "image/png")]);
    const post = writes().find((c) => c.key === "POST /api/workspace/files")!;
    expect((post.body as FormData).get("collection_id")).toBe("c1");
  });

  it("removes a photo from the open collection only", async () => {
    await open({ files: [photo("hero", ["c1"])], collections: [landing(1)] });
    fireEvent.click(screen.getByRole("button", { name: /^landing/ }));
    chooseAction("hero.png", "Remove from this collection");
    expect(writes().map((c) => c.key)).toEqual(["DELETE /api/workspace/file-collections/c1/files/hero"]);
    expect(screen.queryByRole("img", { name: "hero.png" })).toBeNull();
    await reply("DELETE /api/workspace/file-collections/c1/files/hero", { status: 204 });
    fireEvent.click(screen.getByRole("button", { name: "Collections" }));
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
  });

  it("opens a collection from its card, scopes to it, and the breadcrumb goes back to every file", async () => {
    await open({ files: [photo("hero", ["c1"]), photo("team")], collections: [landing(1)] });
    const region = screen.getByRole("region", { name: "Collections" });
    const card = within(region).getByRole("button", { name: /^landing/ });
    expect(card.textContent).toContain("1 photo");
    expect(Array.from(card.querySelectorAll("img")).map((img) => img.getAttribute("src"))).toEqual([
      "https://cdn.test/hero.png",
    ]);
    expect(screen.getAllByRole("img", { name: "hero.png" })).toHaveLength(1);

    fireEvent.click(card);
    expect(screen.queryByRole("region", { name: "Collections" })).toBeNull();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByText("landing").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "team.png" })).toBeNull();

    fireEvent.click(within(crumb).getByRole("button", { name: "Collections" }));
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(screen.getByRole("region", { name: "Collections" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "team.png" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();

    pick([upload("new.png", "image/png")]);
    const post = writes().find((c) => c.key === "POST /api/workspace/files")!;
    expect((post.body as FormData).get("collection_id")).toBeNull();
  });

  it("runs a collection's card menu without opening it", async () => {
    const { onUseOnSite } = await open({
      files: [photo("hero", ["c1"]), photo("team", ["c1"]), photo("other")],
      collections: [landing(2)],
    });
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "land" } });
    fireEvent.click(screen.getByRole("button", { name: "Collection actions for landing" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Use on site" }));
    expect(onUseOnSite).toHaveBeenCalledWith([{ name: "hero.png", url: "https://cdn.test/hero.png" }, { name: "team.png", url: "https://cdn.test/team.png" }]);
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collection actions for landing" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const dialog = screen.getByRole("dialog", { name: "Rename collection" });
    expect((within(dialog).getByRole("textbox", { name: "Collection name" }) as HTMLInputElement).value).toBe("landing");
    expect(writes()).toEqual([]);
  });

  it("keeps the dashed create card last and opens the create dialog from it", async () => {
    await open({
      files: [photo("hero")],
      collections: [landing(0), { id: "c2", name: "about", created_at: "", file_count: 0 }],
    });
    const region = screen.getByRole("region", { name: "Collections" });
    const tiles = within(region)
      .getAllByRole("button")
      .filter((b) => !b.hasAttribute("aria-haspopup"));
    expect(tiles).toHaveLength(3);
    expect(tiles[2]!.textContent).toBe("Create collection");

    fireEvent.click(tiles[2]!);
    const dialog = screen.getByRole("dialog", { name: "Create collection" });
    const input = within(dialog).getByRole("textbox", { name: "Collection name" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "team" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await reply("POST /api/workspace/file-collections", {
      status: 201,
      body: { collection: { id: "c3", name: "team", created_at: "", file_count: 0 } },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("team")).toBeTruthy();
  });

  it("counts files by type from the scope and search, filters by type, and drops a hidden selection", async () => {
    await open({
      files: [
        fileOf("hero", "hero.png", "image/png", ["c1"]),
        fileOf("team", "team.jpg", "image/jpeg"),
        fileOf("clip", "clip.mp4", "video/mp4"),
        fileOf("brief", "brief.pdf", "application/pdf", ["c1"]),
      ],
      collections: [landing(2)],
    });
    const chips = () =>
      within(screen.getByRole("group", { name: "Filter by type" }))
        .getAllByRole("button")
        .map((b) => b.textContent);
    expect(chips()).toEqual(["All files4", "Images2", "Videos1", "Documents1"]);
    expect(screen.getByRole("img", { name: "hero.png" }).closest("li")!.textContent).toContain("PNG");
    expect(screen.getByRole("img", { name: "team.jpg" }).closest("li")!.textContent).toContain("JPG");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select hero.png" }));
    expect(screen.getByRole("toolbar", { name: "Selected photos" }).textContent).toContain("1 selected");
    fireEvent.click(screen.getByRole("button", { name: /^Videos/ }));
    expect(screen.getByRole("button", { name: /^Videos/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^All files/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("clip.mp4")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "hero.png" })).toBeNull();
    expect(screen.queryByText("brief.pdf")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Images/ }));
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "team.jpg" })).toBeTruthy();
    expect(screen.queryByText("clip.mp4")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "te" } });
    expect(chips()).toEqual(["All files1", "Images1", "Videos0", "Documents0"]);
    fireEvent.click(screen.getByRole("button", { name: /^Documents/ }));
    expect(screen.getByText("No matching files")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "team.jpg" })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^landing/ }));
    expect(chips()).toEqual(["All files2", "Images1", "Videos0", "Documents1"]);
    expect(screen.getByText("brief.pdf")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "hero.png" })).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("switches between grid and list and keeps every action reachable in the list", async () => {
    const { onUseOnSite } = await open({
      files: [photo("hero"), photo("team", [], "2026-09-21T10:00:00.000Z")],
      collections: [],
    });
    const photos = () => screen.getByRole("list", { name: "Photos" });
    expect(screen.getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("true");
    expect(photos().querySelector("time")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("button", { name: "List view" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("false");
    expect(
      Array.from(photos().querySelectorAll("time"))
        .map((t) => t.getAttribute("dateTime"))
        .sort(),
    ).toEqual(["2026-09-20T10:00:00.000Z", "2026-09-21T10:00:00.000Z"]);
    expect(within(photos()).getAllByText("2 KB")).toHaveLength(2);
    const header = within(photos()).getByText("Name").closest("li")!;
    expect(header.getAttribute("aria-hidden")).toBe("true");
    const row = within(photos()).getByText("hero.png").closest("li")!;
    expect(within(header).getByText("Updated").className).toBe(row.querySelector("time")!.className.replace(/ text-\S+/g, ""));
    expect(within(header).getByText("Size").className).toBe(within(row).getByText("2 KB").className.replace(/ text-\S+/g, ""));
    expect(within(photos()).getByRole("img", { name: "hero.png" }).getAttribute("loading")).toBe("lazy");

    chooseAction("team.png", "Use on site");
    expect(onUseOnSite).toHaveBeenCalledWith([{ name: "team.png", url: "https://cdn.test/team.png" }]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select hero.png" }));
    expect(screen.getByRole("toolbar", { name: "Selected photos" }).textContent).toContain("1 selected");

    pick([upload("new.png", "image/png")]);
    expect(within(photos()).queryByText("Uploading…")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Uploads" })).getByText("new.png")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(photos().querySelector("time")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Select hero.png" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("toolbar", { name: "Selected photos" }).textContent).toContain("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    chooseAction("hero.png", "Delete");
    expect(screen.getByRole("dialog", { name: "Delete this photo?" })).toBeTruthy();
    expect(writes().map((c) => c.key)).toEqual(["POST /api/workspace/files"]);
  });

  it("tracks uploads in a bottom-right tray, counts them done over total, then fades it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open({ files: [photo("old")], collections: [] });
    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");
    expect(screen.queryByRole("region", { name: "Uploads" })).toBeNull();

    pick([upload("hero.png", "image/png"), upload("team.png", "image/png")]);
    const tray = screen.getByRole("region", { name: "Uploads" });
    expect(tray.className.split(/\s+/)).toEqual(expect.arrayContaining(["absolute", "bottom-4", "right-4"]));
    expect(tray.textContent).toContain("Uploading 0/2");
    expect(within(tray).getAllByText("Uploading…")).toHaveLength(2);
    expect(screen.getByRole("status")).toBe(live);
    expect(live.textContent).toContain("Uploading 2 photos");

    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("hero"), photo("team")] } });
    expect(screen.getByRole("region", { name: "Uploads" })).toBe(tray);
    expect(tray.textContent).toContain("Uploaded 2/2");
    expect(within(tray).getAllByText("Uploaded")).toHaveLength(2);
    expect(within(tray).queryAllByRole("img")).toHaveLength(0);
    expect(within(screen.getByRole("list", { name: "Photos" })).queryByText("Uploaded")).toBeNull();
    expect(live.textContent).toContain("2 photos uploaded");

    await act(async () => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByRole("region", { name: "Uploads" })).toBeNull();
    expect(screen.getByRole("status")).toBe(live);
    expect(live.textContent).toBe("");
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
  });

  it("keeps a failure in the tray until it is closed, and closing clears it for the next upload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open({ files: [], collections: [] });
    pick([upload("hero.png", "image/png")]);
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("hero")] } });
    pick([upload("big.png", "image/png")]);
    const tray = screen.getByRole("region", { name: "Uploads" });
    expect(tray.textContent).toContain("Uploading 1/2");
    await reply("POST /api/workspace/files", {
      status: 413,
      body: { error: { code: "too_large", message: "big.png is over the 10 MB limit." } },
    });
    expect(tray.textContent).toContain("Uploaded 1/2");
    expect(tray.textContent).toContain("1 failed");
    expect(within(tray).getByText("big.png is over the 10 MB limit.")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("region", { name: "Uploads" })).toBe(tray);
    expect(within(tray).getByText("hero.png")).toBeTruthy();

    fireEvent.click(within(tray).getByRole("button", { name: "Close uploads" }));
    expect(screen.queryByRole("region", { name: "Uploads" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");

    pick([upload("team.png", "image/png")]);
    const next = screen.getByRole("region", { name: "Uploads" });
    expect(next.textContent).toContain("Uploading 0/1");
    expect(within(next).queryByText("big.png")).toBeNull();
    expect(within(next).queryByText("hero.png")).toBeNull();
  });

  it("hides the tray when closed mid-upload without cancelling, and never pops it back", async () => {
    await open({ files: [], collections: [] });
    pick([upload("hero.png", "image/png")]);
    fireEvent.click(screen.getByRole("button", { name: "Close uploads" }));
    expect(screen.queryByRole("region", { name: "Uploads" })).toBeNull();
    expect(writes().map((c) => c.key)).toEqual(["POST /api/workspace/files"]);

    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("hero")] } });
    expect(screen.queryByRole("region", { name: "Uploads" })).toBeNull();
    expect(screen.getByRole("img", { name: "hero.png" })).toBeTruthy();
  });

  it("keeps an upload that finished behind a closed tray out of the next tray", async () => {
    await open({ files: [], collections: [] });
    pick([upload("hero.png", "image/png")]);
    fireEvent.click(screen.getByRole("button", { name: "Close uploads" }));
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("hero")] } });
    pick([upload("team.png", "image/png")]);
    const tray = screen.getByRole("region", { name: "Uploads" });
    expect(tray.textContent).toContain("Uploading 0/1");
    expect(within(tray).queryByText("hero.png")).toBeNull();
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("team")] } });
    expect(tray.textContent).toContain("Uploaded 1/1");
  });

  it("collapses the tray list and keeps the header count", async () => {
    await open({ files: [], collections: [] });
    pick([upload("hero.png", "image/png")]);
    const tray = screen.getByRole("region", { name: "Uploads" });
    const list = within(tray).getByRole("list");
    const toggle = within(tray).getByRole("button", { name: "Collapse uploads" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);

    fireEvent.click(toggle);
    expect(list.hidden).toBe(true);
    const expand = within(tray).getByRole("button", { name: "Expand uploads" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(tray.textContent).toContain("Uploading 0/1");
    fireEvent.click(expand);
    expect(list.hidden).toBe(false);
  });

  it("drops a row from the tray when that photo is deleted before the tray fades", async () => {
    await open({ files: [], collections: [] });
    pick([upload("hero.png", "image/png"), upload("team.png", "image/png")]);
    await reply("POST /api/workspace/files", { status: 201, body: { files: [photo("hero"), photo("team")] } });
    const tray = screen.getByRole("region", { name: "Uploads" });
    expect(tray.textContent).toContain("Uploaded 2/2");

    chooseAction("hero.png", "Delete");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete this photo?" })).getByRole("button", { name: "Delete" }));
    expect(within(tray).queryByText("hero.png")).toBeNull();
    expect(tray.textContent).toContain("Uploaded 1/1");
  });

  it("sorts newest first by default and flips to oldest first", async () => {
    await open({
      files: [
        photo("mid", [], "2026-09-20T10:00:00.000Z"),
        photo("old", [], "2026-09-18T10:00:00.000Z"),
        photo("new", [], "2026-09-22T10:00:00.000Z"),
      ],
      collections: [],
    });
    const order = () =>
      within(screen.getByRole("list", { name: "Photos" }))
        .getAllByRole("img")
        .map((img) => img.getAttribute("alt"));
    expect(order()).toEqual(["new.png", "mid.png", "old.png"]);
    fireEvent.click(screen.getByRole("button", { name: "Newest first" }));
    expect(order()).toEqual(["old.png", "mid.png", "new.png"]);
    fireEvent.click(screen.getByRole("button", { name: "Oldest first" }));
    expect(order()).toEqual(["new.png", "mid.png", "old.png"]);
  });

  it("shows every checkbox in select mode and clears the selection when it is switched off", async () => {
    await open({ files: [photo("hero"), photo("team")], collections: [] });
    const box = (name: string) => screen.getByRole("checkbox", { name: `Select ${name}` }).closest("label")!;
    const shown = (name: string) => box(name).className.split(/\s+/).includes("opacity-100");
    expect(shown("hero.png")).toBe(false);

    const toggle = screen.getByRole("button", { name: "Select files" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(shown("hero.png")).toBe(true);
    expect(shown("team.png")).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select team.png" }));
    expect(screen.getByRole("toolbar", { name: "Selected photos" }).textContent).toContain("1 selected");
    fireEvent.click(toggle);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByRole("checkbox", { name: "Select team.png" }) as HTMLInputElement).checked).toBe(false);
    expect(shown("hero.png")).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("slides one indicator to the chosen type filter, mounted after the files load", async () => {
    const lefts: Record<string, number> = { "All files": 0, Images: 110, Videos: 220, Documents: 330 };
    const labelOf = (el: HTMLElement) => (el.textContent ?? "").replace(/\d+$/, "");
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("aria-pressed") !== null && labelOf(this) in lefts ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(36);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(0);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return lefts[labelOf(this)] ?? 0;
    });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));

    render(<BuildFilesPane onUseOnSite={vi.fn()} />);
    expect(screen.queryByTestId("kind-indicator")).toBeNull();
    await reply(GET, { status: 200, body: { files: [photo("hero")], collections: [] } });
    const pill = screen.getByTestId("kind-indicator");
    expect(pill.style.transform).toBe("translate(0px, 0px)");
    expect(pill.style.width).toBe("100px");
    expect(pill.style.transition).toBe("none");
    expect(screen.getByRole("button", { name: /^All files/ }).className.split(/\s+/)).not.toContain("bg-bone");

    await act(async () => {
      frames.splice(0).forEach((cb) => cb(0));
    });
    expect(screen.getByTestId("kind-indicator").style.transition).toMatch(/^transform 380ms/);

    fireEvent.click(screen.getByRole("button", { name: /^Videos/ }));
    expect(screen.getByTestId("kind-indicator")).toBe(pill);
    expect(pill.style.transform).toBe("translate(220px, 0px)");
    expect(pill.style.transition).toMatch(/^transform 380ms/);
  });

  it("falls back to a solid active pill when the tabs cannot be measured", async () => {
    await open({ files: [photo("hero")], collections: [] });
    expect(screen.queryByTestId("kind-indicator")).toBeNull();
    expect(screen.getByRole("button", { name: /^All files/ }).className.split(/\s+/)).toContain("bg-bone");
    fireEvent.click(screen.getByRole("button", { name: /^Images/ }));
    expect(screen.getByRole("button", { name: /^Images/ }).className.split(/\s+/)).toContain("bg-bone");
    expect(screen.getByRole("button", { name: /^All files/ }).className.split(/\s+/)).not.toContain("bg-bone");
  });

  it("lifts the row whose menu is open above the rows after it, in list and grid", async () => {
    await open({
      files: [photo("hero"), photo("team", [], "2026-09-19T10:00:00.000Z"), photo("logo", [], "2026-09-18T10:00:00.000Z")],
      collections: [landing(0)],
    });
    const rowOf = (name: string) => screen.getByRole("button", { name: `Actions for ${name}` }).closest("li")!;
    const lifted = (li: Element) => li.className.split(/\s+/).includes("z-10");

    for (const mode of ["Grid view", "List view"]) {
      fireEvent.click(screen.getByRole("button", { name: mode }));
      expect(lifted(rowOf("hero.png"))).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Actions for hero.png" }));
      expect(screen.getByRole("menu")).toBeTruthy();
      expect(rowOf("hero.png").contains(screen.getByRole("menu"))).toBe(true);
      expect(lifted(rowOf("hero.png"))).toBe(true);
      expect(lifted(rowOf("team.png"))).toBe(false);
      expect(lifted(rowOf("logo.png"))).toBe(false);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(lifted(rowOf("hero.png"))).toBe(false);
    }

    const card = screen.getByRole("button", { name: "Collection actions for landing" }).closest("li")!;
    fireEvent.click(screen.getByRole("button", { name: "Collection actions for landing" }));
    expect(lifted(card)).toBe(true);
  });

  it("never lets the row entrance animation hold a transform after it ends", () => {
    const animation = (tailwindConfig.theme?.extend?.animation as Record<string, string>)["tab-enter"]!;
    expect(animation).toMatch(/^tab-enter /);
    expect(animation).not.toMatch(/\b(both|forwards)\b/);
    expect(animation).toMatch(/\bbackwards\b/);
  });

  it("closes an open dialog when the pane is hidden, so Tab and Escape work elsewhere", async () => {
    const onUseOnSite = vi.fn();
    const outside = document.createElement("button");
    document.body.append(outside);
    const tree = (shown: boolean) => (
      <div hidden={!shown}>
        <BuildFilesPane onUseOnSite={onUseOnSite} active={shown} />
      </div>
    );
    const view = render(tree(true));
    await reply(GET, { status: 200, body: { files: [photo("hero")], collections: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Actions for hero.png" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete this photo?" })).toBeTruthy();
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);

    view.rerender(tree(false));
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    outside.focus();
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(outside);

    view.rerender(tree(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for hero.png" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    view.rerender(tree(false));
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    expect(writes()).toEqual([]);
    outside.remove();
  });

  it("lets Tab and Escape through when a dialog's pane is hidden without being told", async () => {
    const onUseOnSite = vi.fn();
    const tree = (shown: boolean) => (
      <div hidden={!shown}>
        <BuildFilesPane onUseOnSite={onUseOnSite} />
      </div>
    );
    const view = render(tree(true));
    await reply(GET, { status: 200, body: { files: [photo("hero")], collections: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Actions for hero.png" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    view.rerender(tree(false));
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    view.rerender(tree(true));
    expect(screen.getByRole("dialog", { name: "Delete this photo?" })).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("drops a selection the search hides, so bulk delete never touches it", async () => {
    await open({ files: [photo("hero"), photo("team"), photo("tent")], collections: [] });
    for (const name of ["hero", "team", "tent"]) fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}.png` }));
    expect(screen.getByRole("toolbar", { name: "Selected photos" }).textContent).toContain("3 selected");

    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "te" } });
    expect(screen.getByRole("toolbar", { name: "Selected photos" }).textContent).toContain("2 selected");
    chooseAction("team.png", "Delete 2 photos");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete 2 photos?" })).getByRole("button", { name: "Delete" }));
    expect(new Set(writes().map((c) => c.key))).toEqual(
      new Set(["DELETE /api/workspace/files/team", "DELETE /api/workspace/files/tent"]),
    );
    expect(writes()).toHaveLength(2);
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "" } });
    expect((screen.getByRole("checkbox", { name: "Select hero.png" }) as HTMLInputElement).checked).toBe(false);
  });

  it("deletes a large selection a few requests at a time, and still deletes all of it", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
    await open({ files: ids.map((id) => photo(id)), collections: [] });
    for (const id of ids) fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}.png` }));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Selected photos" })).getByRole("button", { name: "Delete 11 photos" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete 11 photos?" })).getByRole("button", { name: "Delete" }));

    const inFlight = () => net.pending.filter((p) => p.key.startsWith("DELETE ")).length;
    let peak = inFlight();
    expect(peak).toBeGreaterThan(1);
    while (inFlight() > 0) {
      const next = net.pending.find((p) => p.key.startsWith("DELETE "))!;
      await reply(next.key, { status: 204 });
      peak = Math.max(peak, inFlight());
    }
    expect(peak).toBeLessThanOrEqual(4);
    expect(new Set(writes().map((c) => c.key))).toEqual(new Set(ids.map((id) => `DELETE /api/workspace/files/${id}`)));
    expect(writes()).toHaveLength(11);
    expect(screen.queryByRole("list", { name: "Photos" })).toBeNull();
  });

  it("sizes the list columns by the list's own width, never the window's", async () => {
    await open({ files: [photo("hero")], collections: [] });
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    const list = screen.getByRole("list", { name: "Photos" });
    const row = within(list).getByText("hero.png").closest("li")!;
    const time = row.querySelector("time")!;
    const size = within(row).getByText("2 KB");
    for (const cell of [time, size]) {
      const classes = cell.className.split(/\s+/);
      expect(classes).toContain("hidden");
      expect(classes.some((c) => /^(sm|md|lg|xl|2xl):/.test(c))).toBe(false);
      expect(classes.some((c) => /^\[@container\(min-width:\d+px\)\]:block$/.test(c))).toBe(true);
      const container = cell.parentElement!.closest('[class*="[container-type:inline-size]"]');
      expect(container).toBe(list);
      expect(container).not.toBe(cell);
    }
  });
});
