// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
  calls: [] as string[],
  signals: [] as AbortSignal[],
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts: { signal?: AbortSignal } = {}) => {
    net.calls.push(path);
    if (opts.signal) net.signals.push(opts.signal);
    return new Promise((resolve) => {
      const queue = net.pending.get(path) ?? [];
      queue.push((r: Reply) =>
        resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }),
      );
      net.pending.set(path, queue);
    });
  },
}));

const hl = vi.hoisted(() => ({ result: null as unknown }));
const rows = vi.hoisted(() => ({ gutters: 0 }));
vi.mock("../layout/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../layout/shared")>();
  return {
    ...actual,
    cx: (...parts: Parameters<typeof actual.cx>) => {
      if (typeof parts[0] === "string" && parts[0].startsWith("sticky left-0")) rows.gutters += 1;
      return actual.cx(...parts);
    },
  };
});

vi.mock("@/lib/workspace/codeHighlight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/codeHighlight")>()),
  highlightCode: async () => hl.result,
}));

import { AppCodePane, buildCodeTree, closeTab, parentDirs, pickDefaultFile } from "./AppCodePane";
import { clearAppCodeCache } from "@/lib/workspace/appCodeCache";
import { BUILD_REFINE_FINISHED_EVENT } from "@/lib/workspace/useBuildSession";

const TREE = "/api/workspace/app-code/tree?app=workspace";
const file = (path: string) => `/api/workspace/app-code/file?path=${encodeURIComponent(path)}&app=workspace`;

async function reply(path: string, r: Reply) {
  const queue = net.pending.get(path);
  const next = queue?.shift();
  if (!next) throw new Error(`no pending request for ${path}`);
  await act(async () => {
    next(r);
  });
}

const ENTRIES = [
  { path: "src", type: "dir" },
  { path: "src/routes", type: "dir" },
  { path: "src/routes/index.tsx", type: "file", size: 20 },
  { path: "src/app.tsx", type: "file", size: 10 },
  { path: "package.json", type: "file", size: 5 },
  { path: ".env.example", type: "file", size: 5 },
];

afterEach(() => {
  cleanup();
  clearAppCodeCache();
  hl.result = null;
  net.pending.clear();
  net.calls.length = 0;
  net.signals.length = 0;
});

describe("buildCodeTree", () => {
  it("nests files under their folders, folders first, and invents missing parents", () => {
    const tree = buildCodeTree([
      { path: "b.txt", type: "file" },
      { path: "a/deep/x.ts", type: "file" },
      { path: "a/y.ts", type: "file" },
      { path: "c", type: "dir" },
    ]);
    expect(tree.map((n) => n.path)).toEqual(["a", "c", "b.txt"]);
    const a = tree[0]!;
    expect(a.children.map((n) => n.path)).toEqual(["a/deep", "a/y.ts"]);
    expect(a.children[0]!.children.map((n) => n.path)).toEqual(["a/deep/x.ts"]);
  });
});

describe("AppCodePane", () => {
  it("shows the newest file even when an older request answers last", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });

    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    fireEvent.click(screen.getByRole("button", { name: "app.tsx" }));

    await reply(file("src/app.tsx"), { status: 200, body: { kind: "text", content: "const newest = 1;\n" } });
    await reply(file("package.json"), { status: 200, body: { kind: "text", content: "{ \"stale\": true }\n" } });

    expect(screen.getByText("const newest = 1;")).toBeTruthy();
    expect(screen.queryByText(/stale/)).toBeNull();
    expect(screen.getByRole("tab", { name: "src/app.tsx" }).getAttribute("aria-selected")).toBe("true");
  });

  it("aborts the file read when the pane goes away mid-flight", async () => {
    const { unmount } = render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    const fileSignal = net.signals[net.signals.length - 1]!;
    expect(fileSignal.aborted).toBe(false);
    unmount();
    expect(fileSignal.aborted).toBe(true);
  });

  it("numbers every line of the file", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    await reply(file("package.json"), { status: 200, body: { kind: "text", content: "a\nb\nc\n" } });
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.queryByText("4")).toBeNull();
  });

  it("says why a refused file cannot be shown instead of a blank pane", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    fireEvent.click(screen.getByRole("button", { name: ".env.example" }));
    await reply(file(".env.example"), {
      status: 403,
      body: { error: { code: "secret_file", message: "Environment files are not shown here." } },
    });
    expect(screen.getByRole("alert").textContent).toBe("Environment files are not shown here.");
  });

  it("explains a binary file", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    await reply(file("package.json"), { status: 200, body: { kind: "binary", size: 4 } });
    expect(screen.getByText(/binary file/)).toBeTruthy();
  });

  it("opens top-level folders and keeps nested ones folded", async () => {
    render(<AppCodePane />);
    await reply(TREE, {
      status: 200,
      body: {
        entries: [
          { path: "src", type: "dir" },
          { path: "src/routes", type: "dir" },
          { path: "src/routes/index.tsx", type: "file", size: 20 },
          { path: "src/app.tsx", type: "file", size: 10 },
          { path: "notes.txt", type: "file", size: 5 },
        ].map((e) => (e.path === "src/routes/index.tsx" ? { ...e, path: "src/routes/home.tsx" } : e)),
      },
    });
    expect(screen.getByRole("button", { name: "app.tsx" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "home.tsx" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "routes" }));
    expect(screen.getByRole("button", { name: "home.tsx" })).toBeTruthy();
  });

  it("searches across folded folders by path", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    fireEvent.change(screen.getByPlaceholderText("Search code"), { target: { value: "INDEX" } });
    expect(screen.getByRole("button", { name: "src/routes/index.tsx" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "package.json" })).toBeNull();
  });

  it("tells a workspace with no built app that there is no code yet", async () => {
    render(<AppCodePane />);
    await reply(TREE, {
      status: 409,
      body: { error: { code: "no_provisioned_repo", message: "This workspace has no built app code yet." } },
    });
    expect(screen.getByText("No code yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("retries a failed tree load", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 502, body: { error: { message: "Could not read the app code." } } });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(net.calls.filter((c) => c === TREE)).toHaveLength(2));
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    expect(screen.getByRole("button", { name: "package.json" })).toBeTruthy();
  });

  it("keeps each open file in its own tab and switches between them without refetching", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    await reply(file("package.json"), { status: 200, body: { kind: "text", content: "pkg\n" } });
    fireEvent.click(screen.getByRole("button", { name: "app.tsx" }));
    await reply(file("src/app.tsx"), { status: 200, body: { kind: "text", content: "app\n" } });

    fireEvent.click(screen.getByRole("tab", { name: "package.json" }));
    expect(screen.getByText("pkg")).toBeTruthy();
    expect(net.calls.filter((c) => c === file("package.json"))).toHaveLength(1);
  });

  it("closing the active tab lands on its neighbour and drops a reply still in flight", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    await reply(file("package.json"), { status: 200, body: { kind: "text", content: "pkg\n" } });
    fireEvent.click(screen.getByRole("button", { name: "app.tsx" }));
    const signal = net.signals[net.signals.length - 1]!;

    fireEvent.click(screen.getByRole("button", { name: "Close src/app.tsx" }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("tab", { name: "src/app.tsx" })).toBeNull();
    expect(screen.getByRole("tab", { name: "package.json" }).getAttribute("aria-selected")).toBe("true");

    await reply(file("src/app.tsx"), { status: 200, body: { kind: "text", content: "ghost\n" } });
    expect(screen.queryByText("ghost")).toBeNull();
    expect(screen.queryByRole("tab", { name: "src/app.tsx" })).toBeNull();
  });

  it("paints highlighted tokens with both theme colours so dark mode can swap them", async () => {
    hl.result = [[{ content: "const", light: "#0000FF", dark: "#569CD6" }, { content: " x", light: "#000000", dark: "#D4D4D4" }]];
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    fireEvent.click(screen.getByRole("button", { name: "app.tsx" }));
    await reply(file("src/app.tsx"), { status: 200, body: { kind: "text", content: "const x\n" } });
    const token = await screen.findByText("const");
    expect(token.className).toContain("code-token");
    expect(token.style.getPropertyValue("--tok-light")).toBe("#0000FF");
    expect(token.style.getPropertyValue("--tok-dark")).toBe("#569CD6");
  });

  it("labels tabs with the file path and offers copy and download, leaving the read-only badge to the surface header", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES, branch: "main" } });
    fireEvent.click(screen.getByRole("button", { name: "app.tsx" }));
    await reply(file("src/app.tsx"), { status: 200, body: { kind: "text", content: "a\nb\nc\n" } });
    expect(screen.getByRole("tab", { name: "src/app.tsx" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Read only")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Breadcrumbs" })).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download file" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe("closeTab", () => {
  it("activates the right neighbour, or the left one at the end", () => {
    expect(closeTab(["a", "b", "c"], "b", "b")).toEqual({ open: ["a", "c"], active: "c" });
    expect(closeTab(["a", "b", "c"], "c", "c")).toEqual({ open: ["a", "b"], active: "b" });
    expect(closeTab(["a"], "a", "a")).toEqual({ open: [], active: null });
  });
  it("leaves the active tab alone when another one closes", () => {
    expect(closeTab(["a", "b"], "a", "b")).toEqual({ open: ["a"], active: "a" });
  });
});

describe("Code tab polish", () => {
  it("opens a sensible default file so the editor never starts empty", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES, name: "mohit-93bd8436" } });
    expect(net.calls).toContain(file("src/routes/index.tsx"));
    expect(screen.getByRole("tab", { name: "src/routes/index.tsx" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "index.tsx" })).toBeTruthy();
  });

  it("jumps to the file search with Cmd+P and opens the first match on Enter, revealing its folder", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    const search = screen.getByPlaceholderText("Search code");
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "index" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(net.calls).toContain(file("src/routes/index.tsx"));
    expect((search as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "index.tsx" })).toBeTruthy();
  });

  it("collapses every folder at once", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    expect(screen.getByRole("button", { name: "app.tsx" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse folders" }));
    expect(screen.queryByRole("button", { name: "app.tsx" })).toBeNull();
  });

  it("copies the open file's contents", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    await reply(file("src/routes/index.tsx"), { status: 200, body: { kind: "text", content: "{ }\n" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy file" }));
    });
    expect(writeText).toHaveBeenCalledWith("{ }\n");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    const download = screen.getByRole("button", { name: "Download file" });
    expect(download.textContent).toBe("");
    expect(download.getAttribute("title")).toBe("Download file");
  });
});

describe("pickDefaultFile / parentDirs", () => {
  it("prefers the README, then the app entry, then package.json", () => {
    expect(pickDefaultFile([{ path: "package.json", type: "file" }, { path: "README.md", type: "file" }])).toBe("README.md");
    expect(pickDefaultFile([{ path: "package.json", type: "file" }, { path: "src/App.tsx", type: "file" }])).toBe("src/App.tsx");
    expect(pickDefaultFile([{ path: "src/x.ts", type: "file" }])).toBeNull();
  });
  it("lists every folder above a file", () => {
    expect(parentDirs("src/routes/index.tsx")).toEqual(["src", "src/routes"]);
    expect(parentDirs("package.json")).toEqual([]);
  });
});

describe("AppCodePane cache across visits", () => {
  const SHA_ENTRIES = [
    { path: "src", type: "dir" },
    { path: "src/routes", type: "dir" },
    { path: "src/routes/index.tsx", type: "file", size: 20, sha: "s1" },
    { path: "package.json", type: "file", size: 5, sha: "p1" },
  ];
  const INDEX = file("src/routes/index.tsx");
  const callsTo = (path: string) => net.calls.filter((c) => c === path).length;

  async function firstVisit(scope: string) {
    const view = render(<AppCodePane scope={scope} />);
    await reply(TREE, { status: 200, body: { entries: SHA_ENTRIES, name: "shop" } });
    await reply(INDEX, { status: 200, body: { kind: "text", content: "export const one = 1;\n" } });
    expect(screen.getByText("export const one = 1;")).toBeTruthy();
    view.unmount();
    net.calls.length = 0;
    net.pending.clear();
  }

  it("paints the tree and the open file on the second visit without reading the file again", async () => {
    await firstVisit("shop.zaviagent.com");
    render(<AppCodePane scope="shop.zaviagent.com" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("export const one = 1;")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "src/routes/index.tsx" }).getAttribute("aria-selected")).toBe("true");
    expect(callsTo(TREE)).toBe(1);
    await reply(TREE, { status: 200, body: { entries: SHA_ENTRIES, name: "shop" } });
    expect(callsTo(INDEX)).toBe(0);
    expect(screen.getByText("export const one = 1;")).toBeTruthy();
  });

  it("reopens a closed tab from the cache instead of the network", async () => {
    await firstVisit("shop.zaviagent.com");
    render(<AppCodePane scope="shop.zaviagent.com" />);
    await reply(TREE, { status: 200, body: { entries: SHA_ENTRIES, name: "shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Close src/routes/index.tsx" }));
    expect(screen.queryByText("export const one = 1;")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "index.tsx" }));
    expect(screen.getByText("export const one = 1;")).toBeTruthy();
    expect(callsTo(INDEX)).toBe(0);
  });

  it("refetches an open file once a rebuild changed its content", async () => {
    await firstVisit("shop.zaviagent.com");
    render(<AppCodePane scope="shop.zaviagent.com" />);
    const rebuilt = SHA_ENTRIES.map((e) => (e.path === "src/routes/index.tsx" ? { ...e, sha: "s2" } : e));
    await reply(TREE, { status: 200, body: { entries: rebuilt, name: "shop" } });
    expect(callsTo(INDEX)).toBe(1);
    await reply(INDEX, { status: 200, body: { kind: "text", content: "export const two = 2;\n" } });
    expect(screen.getByText("export const two = 2;")).toBeTruthy();
    expect(screen.queryByText("export const one = 1;")).toBeNull();
  });

  it("keeps the cached code on screen when the background refresh fails", async () => {
    await firstVisit("shop.zaviagent.com");
    render(<AppCodePane scope="shop.zaviagent.com" />);
    await reply(TREE, { status: 502, body: { error: { message: "GitHub is down" } } });
    expect(screen.getByText("export const one = 1;")).toBeTruthy();
    expect(screen.queryByText("Could not load the code")).toBeNull();
  });

  it("never shows one app's cached code to another app", async () => {
    await firstVisit("shop.zaviagent.com");
    render(<AppCodePane scope="other.zaviagent.com" />);
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("export const one = 1;")).toBeNull();
    expect(screen.queryByRole("tab", { name: "src/routes/index.tsx" })).toBeNull();
  });

  it("does not cache at all when no app scope is given", async () => {
    await firstVisit("shop.zaviagent.com");
    render(<AppCodePane />);
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
  });

  it("does not cache a file whose read failed", async () => {
    const view = render(<AppCodePane scope="shop.zaviagent.com" />);
    await reply(TREE, { status: 200, body: { entries: SHA_ENTRIES, name: "shop" } });
    await reply(INDEX, { status: 502, body: { error: { message: "Could not read the file." } } });
    view.unmount();
    net.calls.length = 0;
    net.pending.clear();
    render(<AppCodePane scope="shop.zaviagent.com" />);
    expect(callsTo(INDEX)).toBe(1);
  });
});

describe("ReadOnlyBadge", () => {
  it("explains why the code is read only on click and closes on Escape", async () => {
    const { ReadOnlyBadge } = await import("./AppCodePane");
    render(<ReadOnlyBadge />);
    const badge = screen.getByRole("button", { name: "Read only" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(badge.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(badge);
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    const note = screen.getByRole("tooltip");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(badge.getAttribute("aria-describedby")).toBe(note.id);
    expect(note.textContent).toContain("Describe what you want in the chat");
    expect(note.className.split(" ")).toContain("right-0");
    expect(note.className).not.toMatch(/(^|\s)(left-|-translate-x-1\/2)/);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(badge.getAttribute("aria-describedby")).toBeNull();
  });
});

function finishRefine(refineId: string) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(BUILD_REFINE_FINISHED_EVENT, { detail: { sessionId: "s", refineId, status: "done" } }),
    );
  });
}

describe("AppCodePane while hidden behind another build tab", () => {
  it("leaves Cmd+P to the browser and the search box alone while the pane is hidden", async () => {
    const view = render(<AppCodePane active={false} />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    const search = screen.getByPlaceholderText("Search code");
    expect(fireEvent.keyDown(window, { key: "p", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "P", ctrlKey: true })).toBe(true);
    expect(document.activeElement).not.toBe(search);
    view.rerender(<AppCodePane active />);
    expect(fireEvent.keyDown(window, { key: "p", metaKey: true })).toBe(false);
    expect(document.activeElement).toBe(search);
    view.rerender(<AppCodePane active={false} />);
    (document.activeElement as HTMLElement).blur();
    expect(fireEvent.keyDown(window, { key: "p", ctrlKey: true })).toBe(true);
    expect(document.activeElement).not.toBe(search);
  });
});

describe("AppCodePane after a change ships", () => {
  const SHIPPED = [
    { path: "src", type: "dir" },
    { path: "src/routes", type: "dir" },
    { path: "src/routes/index.tsx", type: "file", size: 20, sha: "s1" },
    { path: "package.json", type: "file", size: 5, sha: "p1" },
  ];
  const INDEX = file("src/routes/index.tsx");
  const callsTo = (path: string) => net.calls.filter((c) => c === path).length;

  async function mountWithIndex(active: boolean) {
    const view = render(<AppCodePane scope="shop.zaviagent.com" active={active} />);
    await reply(TREE, { status: 200, body: { entries: SHIPPED, name: "shop" } });
    await reply(INDEX, { status: 200, body: { kind: "text", content: "export const one = 1;\n" } });
    expect(screen.getByText("export const one = 1;")).toBeTruthy();
    return view;
  }

  it("rereads the tree when the hidden pane comes back after a change finished, and shows the new code", async () => {
    const view = await mountWithIndex(false);
    finishRefine("r1");
    expect(callsTo(TREE)).toBe(1);
    view.rerender(<AppCodePane scope="shop.zaviagent.com" active />);
    expect(callsTo(TREE)).toBe(2);
    expect(screen.getByText("export const one = 1;")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    const rebuilt = SHIPPED.map((e) => (e.path === "src/routes/index.tsx" ? { ...e, sha: "s2" } : e));
    await reply(TREE, { status: 200, body: { entries: rebuilt, name: "shop" } });
    expect(callsTo(INDEX)).toBe(2);
    await reply(INDEX, { status: 200, body: { kind: "text", content: "export const two = 2;\n" } });
    expect(screen.getByText("export const two = 2;")).toBeTruthy();
    expect(screen.queryByText("export const one = 1;")).toBeNull();
    view.rerender(<AppCodePane scope="shop.zaviagent.com" active={false} />);
    view.rerender(<AppCodePane scope="shop.zaviagent.com" active />);
    expect(callsTo(TREE)).toBe(2);
  });

  it("rereads right away when the pane is on screen, once per change, and ignores a slower stale read", async () => {
    await mountWithIndex(true);
    finishRefine("r1");
    finishRefine("r1");
    expect(callsTo(TREE)).toBe(2);
    const firstSignal = net.signals[net.signals.length - 1]!;
    finishRefine("r2");
    expect(callsTo(TREE)).toBe(3);
    expect(firstSignal.aborted).toBe(true);
    await reply(TREE, { status: 200, body: { entries: SHIPPED, name: "shop" } });
    const rebuilt = SHIPPED.map((e) => (e.path === "src/routes/index.tsx" ? { ...e, sha: "s3" } : e));
    await reply(TREE, { status: 200, body: { entries: rebuilt, name: "shop" } });
    await reply(INDEX, { status: 200, body: { kind: "text", content: "export const three = 3;\n" } });
    expect(screen.getByText("export const three = 3;")).toBeTruthy();
  });

  it("drops the tree read when the pane unmounts mid-refresh", async () => {
    const view = await mountWithIndex(true);
    finishRefine("r1");
    const signal = net.signals[net.signals.length - 1]!;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("closes an open tab whose file the latest build deleted and lands on its neighbour", async () => {
    await mountWithIndex(true);
    fireEvent.click(screen.getByRole("button", { name: "package.json" }));
    await reply(file("package.json"), { status: 200, body: { kind: "text", content: "{ \"name\": \"shop\" }\n" } });
    fireEvent.click(screen.getByRole("tab", { name: "src/routes/index.tsx" }));
    finishRefine("r1");
    await reply(TREE, {
      status: 200,
      body: { entries: SHIPPED.filter((e) => e.path !== "src/routes/index.tsx"), name: "shop" },
    });
    expect(screen.queryByRole("tab", { name: "src/routes/index.tsx" })).toBeNull();
    expect(screen.queryByText("export const one = 1;")).toBeNull();
    expect(screen.getByRole("tab", { name: "package.json" }).getAttribute("aria-selected")).toBe("true");
    expect(callsTo(INDEX)).toBe(1);
  });

  it("keeps a tab open when the refreshed tree is truncated and simply does not list it", async () => {
    await mountWithIndex(true);
    finishRefine("r1");
    await reply(TREE, {
      status: 200,
      body: { entries: SHIPPED.filter((e) => e.path !== "src/routes/index.tsx"), truncated: true, name: "shop" },
    });
    expect(screen.getByRole("tab", { name: "src/routes/index.tsx" })).toBeTruthy();
    expect(screen.getByText("export const one = 1;")).toBeTruthy();
  });
});

describe("CodeView line clicks", () => {
  it("re-renders only the old and the new active line, not every line of the file", async () => {
    render(<AppCodePane />);
    await reply(TREE, { status: 200, body: { entries: ENTRIES } });
    const content = Array.from({ length: 200 }, (_, i) => `row${i + 1}`).join("\n") + "\n";
    await reply(file("src/routes/index.tsx"), { status: 200, body: { kind: "text", content } });
    expect(screen.getByText("row200")).toBeTruthy();
    rows.gutters = 0;
    fireEvent.mouseDown(screen.getByText("row57"));
    expect(rows.gutters).toBe(2);
    rows.gutters = 0;
    fireEvent.mouseDown(screen.getByText("row58"));
    expect(rows.gutters).toBe(2);
  });
});
