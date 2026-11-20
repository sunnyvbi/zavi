// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const session = vi.hoisted(() => ({ clearers: new Set<() => void>() }));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({
  registerSessionScopedCache: (clear: () => void) => session.clearers.add(clear),
}));
vi.mock("@/components/workspace/WorkspaceShell", () => ({ useWorkspace: vi.fn(), useWorkspaceOptional: vi.fn() }));
import { apiFetch } from "@/lib/api";
import { CopyMessageButton } from "../CopyMessageButton";
import { BuildRating, RATING_REASON_PLACEHOLDER, RATING_SAVE_FAILED, RATING_THANKS_CARRYOVER, resetBuildRatingCache } from "./BuildRating";

const B1 = "44444444-4444-4444-8444-444444444444";
const B2 = "55555555-5555-4555-8555-555555555555";
const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let saved: Record<string, { rating: -1 | 1; comment: string | null; reasons?: string[] }> = {};
let failPost = false;
let carryover = false;
const posts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetBuildRatingCache();
  saved = {};
  failPost = false;
  carryover = false;
  posts.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (path.startsWith("/api/feedback/mine")) {
      const ids = new URL(`http://x${path}`).searchParams.get("ids")!.split(",");
      return json({ ratings: Object.fromEntries(ids.filter((id) => saved[id]).map((id) => [id, saved[id]])) });
    }
    if (path === "/api/feedback" && init?.method === "POST") {
      const body = JSON.parse(init.body!);
      posts.push(body);
      return failPost ? json({ error: { message: "nope" } }, 500) : json({ ok: true, carryover: carryover && body.rating === -1 && body.reasons.length > 0 });
    }
    return json({}, 404);
  });
});
afterEach(cleanup);

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); await Promise.resolve(); });

describe("BuildRating", () => {
  it("reads every rating on screen in one request and shows the saved one", async () => {
    saved[B2] = { rating: -1, comment: "generic" };
    render(<><BuildRating runId={B1} label="build" /><BuildRating runId={B2} label="change" /></>);
    await flush();
    const reads = fetchMock.mock.calls.filter(([p]) => String(p).startsWith("/api/feedback/mine"));
    expect(reads).toHaveLength(1);
    expect(String(reads[0]![0])).toBe(`/api/feedback/mine?target_type=conductor_run&ids=${B1},${B2}`);
    expect(screen.getByRole("button", { name: "Good build" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Bad change" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("forgets saved feedback when the signed-in user changes", async () => {
    saved[B1] = { rating: -1, comment: "Private feedback", reasons: ["copy"] };
    const first = render(<BuildRating runId={B1} label="build" />);
    await flush();
    expect(screen.getByRole("button", { name: "Bad build" }).getAttribute("aria-pressed")).toBe("true");
    first.unmount();
    saved = {};
    for (const clear of session.clearers) clear();
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    expect(screen.getByRole("button", { name: "Bad build" }).getAttribute("aria-pressed")).toBe("false");
    expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith("/api/feedback/mine"))).toHaveLength(2);
  });

  it("thumbs up saves the build rating and says thanks", async () => {
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Good build" }));
    await flush();
    expect(posts).toEqual([{ target_type: "conductor_run", target_id: B1, rating: 1, comment: null, reasons: [] }]);
    expect(screen.getByRole("button", { name: "Good build" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Thanks, noted.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByPlaceholderText(RATING_REASON_PLACEHOLDER)).toBeNull();
  });

  it("thumbs down saves at once, then asks what was off; the reason updates the same rating", async () => {
    render(<BuildRating runId={B1} label="change" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad change" }));
    await flush();
    expect(posts).toEqual([{ target_type: "conductor_run", target_id: B1, rating: -1, comment: null, reasons: [] }]);
    const input = screen.getByPlaceholderText(RATING_REASON_PLACEHOLDER);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  The colours are not ours  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(posts[1]).toEqual({ target_type: "conductor_run", target_id: B1, rating: -1, comment: "The colours are not ours", reasons: [] });
    expect(screen.queryByPlaceholderText(RATING_REASON_PLACEHOLDER)).toBeNull();
    expect(screen.queryByText("Thanks, noted.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Skip closes the question and keeps the thumbs down", async () => {
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.queryByPlaceholderText(RATING_REASON_PLACEHOLDER)).toBeNull();
    expect(screen.getByRole("button", { name: "Bad build" }).getAttribute("aria-pressed")).toBe("true");
    expect(posts).toHaveLength(1);
  });

  it("a failed save puts the old rating back and says so", async () => {
    saved[B1] = { rating: 1, comment: null };
    failPost = true;
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(RATING_SAVE_FAILED);
    expect(screen.getByRole("button", { name: "Good build" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByPlaceholderText(RATING_REASON_PLACEHOLDER)).toBeNull();
  });

  it("a failed read shows unrated thumbs that still work", async () => {
    fetchMock.mockImplementationOnce(async () => { throw new Error("offline"); });
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    expect(screen.getByRole("button", { name: "Good build" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Good build" }));
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("a failed read is not remembered: the next row on screen asks again", async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: "down" }, 503));
    saved[B1] = { rating: 1, comment: null };
    const first = render(<BuildRating runId={B1} label="build" />);
    await flush();
    expect(screen.getByRole("button", { name: "Good build" }).getAttribute("aria-pressed")).toBe("false");
    first.unmount();
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    expect(screen.getByRole("button", { name: "Good build" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a save still in flight for the previous run never touches the next run's thumbs", async () => {
    let finish: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/api/feedback/mine")) return json({ ratings: {} });
      if (init?.method === "POST") return new Promise<Response>((r) => (finish = r));
      return json({}, 404);
    });
    const view = render(<BuildRating runId={B1} label="change" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad change" }));
    view.rerender(<BuildRating runId={B2} label="change" />);
    await flush();
    expect(screen.queryByPlaceholderText(RATING_REASON_PLACEHOLDER)).toBeNull();
    await act(async () => finish(json({ error: { message: "nope" } }, 500)));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Bad change" }).getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByRole("button", { name: "Good change" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the reason chips only after a thumbs down, and sends the picked ones with the text", async () => {
    carryover = true;
    render(<BuildRating runId={B1} label="change" />);
    await flush();
    expect(screen.queryByTestId("build-rating-chips")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Good change" }));
    await flush();
    expect(screen.queryByTestId("build-rating-chips")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bad change" }));
    await flush();
    expect(screen.getByTestId("build-rating-chips")).toBeTruthy();
    expect(posts[1]).toEqual({ target_type: "conductor_run", target_id: B1, rating: -1, comment: null, reasons: [] });
    fireEvent.click(screen.getByRole("button", { name: "Wrong words or facts" }));
    fireEvent.click(screen.getByRole("button", { name: "Slow" }));
    fireEvent.click(screen.getByRole("button", { name: "Look or colours" }));
    fireEvent.click(screen.getByRole("button", { name: "Slow" }));
    expect(screen.getByRole("button", { name: "Look or colours" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Slow" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(screen.getByPlaceholderText(RATING_REASON_PLACEHOLDER), { target: { value: "Prices are wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(posts[2]).toEqual({ target_type: "conductor_run", target_id: B1, rating: -1, comment: "Prices are wrong", reasons: ["look", "copy"] });
    expect(screen.queryByTestId("build-rating-chips")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(RATING_THANKS_CARRYOVER);
  });

  it("chips alone can be sent; with carry-over off the thanks stays neutral", async () => {
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Layout" }));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(posts[1]).toEqual({ target_type: "conductor_run", target_id: B1, rating: -1, comment: null, reasons: ["layout"] });
    expect(screen.queryByText("Thanks, noted.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("restores saved reason chips when reopening a negative rating", async () => {
    saved[B1] = { rating: -1, comment: "Too generic", reasons: ["look", "copy"] };
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    expect(screen.getByRole("button", { name: "Look or colours" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Wrong words or facts" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(posts[0]).toMatchObject({ reasons: ["look", "copy"] });
  });

  it("text without chips never claims the next change will use it", async () => {
    carryover = true;
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    fireEvent.change(screen.getByPlaceholderText(RATING_REASON_PLACEHOLDER), { target: { value: "meh" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(posts[1]!.reasons).toEqual([]);
    expect(screen.queryByText("Thanks, noted.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a thumbs down again clears chips picked earlier", async () => {
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Something broken" }));
    fireEvent.click(screen.getByRole("button", { name: "Good build" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    expect(screen.getByRole("button", { name: "Something broken" }).getAttribute("aria-pressed")).toBe("false");
    expect(posts.map((p) => p.reasons)).toEqual([[], [], []]);
  });

  it("two clicks on a thumb before React re-renders send one save", async () => {
    let finish: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path.startsWith("/api/feedback/mine")) return json({ ratings: {} });
      if (init?.method === "POST") {
        posts.push(JSON.parse(init.body!));
        return new Promise<Response>((r) => (finish = r));
      }
      return json({}, 404);
    });
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    const down = screen.getByRole("button", { name: "Bad build" });
    const up = screen.getByRole("button", { name: "Good build" });
    act(() => {
      down.click();
      down.click();
      up.click();
    });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.rating).toBe(-1);
    await act(async () => finish(json({ ok: true, carryover: false })));
    await flush();
    expect(screen.getByRole("button", { name: "Bad build" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Good build" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("two submits of the reason before React re-renders send it once", async () => {
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Layout" }));
    const form = screen.getByTestId("build-rating-reason") as HTMLFormElement;
    act(() => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await flush();
    expect(posts.map((p) => p.reasons)).toEqual([[], ["layout"]]);
  });

  it("like, dislike, like again: each saves once, the last one wins and survives a remount", async () => {
    const view = render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Good build" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    expect(screen.getByTestId("build-rating-chips")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Look or colours" }));
    fireEvent.click(screen.getByRole("button", { name: "Good build" }));
    await flush();
    expect(posts.map((p) => [p.rating, p.reasons])).toEqual([[1, []], [-1, []], [1, []]]);
    expect(screen.queryByTestId("build-rating-chips")).toBeNull();
    expect(screen.queryByText("Thanks, noted.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
    const reads = fetchMock.mock.calls.filter(([p]) => String(p).startsWith("/api/feedback/mine")).length;
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    expect(screen.getByRole("button", { name: "Good build" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Bad build" }).getAttribute("aria-pressed")).toBe("false");
    expect(fetchMock.mock.calls.filter(([p]) => String(p).startsWith("/api/feedback/mine")).length).toBe(reads);
  });

  it("after a reload, clicking the saved thumbs down reopens the question with the saved words and never overwrites them", async () => {
    saved[B1] = { rating: -1, comment: "Prices are wrong" };
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    expect(screen.getByRole("button", { name: "Bad build" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    expect(posts).toEqual([]);
    expect((screen.getByPlaceholderText(RATING_REASON_PLACEHOLDER) as HTMLInputElement).value).toBe("Prices are wrong");
    fireEvent.click(screen.getByRole("button", { name: "Missing section" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(posts).toEqual([{ target_type: "conductor_run", target_id: B1, rating: -1, comment: "Prices are wrong", reasons: ["missing"] }]);
  });

  it("after a reload, clicking the saved thumbs up sends nothing", async () => {
    saved[B1] = { rating: 1, comment: null };
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Good build" }));
    await flush();
    expect(posts).toEqual([]);
    expect(screen.getByRole("button", { name: "Good build" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a failed reason save keeps the question open with the chips picked, and a retry goes through", async () => {
    carryover = true;
    render(<BuildRating runId={B1} label="change" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad change" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Something broken" }));
    failPost = true;
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(RATING_SAVE_FAILED);
    expect(screen.getByRole("button", { name: "Something broken" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Bad change" }).getAttribute("aria-pressed")).toBe("true");
    failPost = false;
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(posts.map((p) => p.reasons)).toEqual([[], ["broken"], ["broken"]]);
    expect(screen.getByRole("status").textContent).toBe(RATING_THANKS_CARRYOVER);
  });

  it("the thumbs and the reason chips work from the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Bad build" }));
    await user.keyboard("{Enter}");
    await flush();
    expect(document.activeElement).toBe(screen.getByPlaceholderText(RATING_REASON_PLACEHOLDER));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Slow" }));
    await user.keyboard(" ");
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Slow" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Something broken" }).getAttribute("aria-pressed")).toBe("true");
    screen.getByPlaceholderText(RATING_REASON_PLACEHOLDER).focus();
    await user.keyboard("{Enter}");
    await flush();
    expect(posts[1]).toMatchObject({ rating: -1, reasons: ["broken", "slow"] });
  });

  it("uses only theme tokens for the chips, so dark mode flips them", async () => {
    render(<BuildRating runId={B1} label="build" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Bad build" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Layout" }));
    const chips = screen.getByTestId("build-rating-chips").querySelectorAll("button");
    for (const chip of chips) expect(chip.className).not.toMatch(/#[0-9a-f]{3,6}|bg-white|text-black|bg-black|text-white/i);
    expect(screen.getByRole("button", { name: "Layout" }).className).toContain("bg-ink");
    expect(screen.getByRole("button", { name: "Layout" }).className).toContain("text-cream");
    expect(screen.getByRole("button", { name: "Slow" }).className).toContain("bg-cream");
  });
});

describe("the thumbs sit beside Copy as the same kind of button", () => {
  const shape = (button: HTMLElement) => {
    const svg = button.querySelector("svg")!;
    return {
      box: button.className.split(/\s+/).filter((c) => !/^(text-ink|text-inkMuted|disabled:opacity-60)$/.test(c)).sort().join(" "),
      width: svg.getAttribute("width"),
      height: svg.getAttribute("height"),
      stroke: svg.getAttribute("stroke-width"),
      sizeClass: /\bh-\[|\bw-\[/.test(svg.getAttribute("class") ?? ""),
    };
  };

  it("matches the Copy button's box, icon size and stroke, unrated and rated, with no hard-coded grey", async () => {
    render(<><CopyMessageButton text="Your app is ready" /><BuildRating runId={B1} label="build" /></>);
    await flush();
    const copy = shape(screen.getByRole("button", { name: "Copy message" }));
    expect(copy.width).toBe("16");
    for (const name of ["Good build", "Bad build"]) {
      const thumb = screen.getByRole("button", { name });
      expect(shape(thumb)).toEqual(copy);
      expect(thumb.className).toContain("text-inkMuted");
      expect(thumb.className).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
    await userEvent.click(screen.getByRole("button", { name: "Good build" }));
    await flush();
    const good = screen.getByRole("button", { name: "Good build" });
    expect(good.getAttribute("aria-pressed")).toBe("true");
    expect(shape(good)).toEqual(copy);
    expect(good.className).toContain("text-ink");
    expect(good.className).not.toContain("text-inkMuted");
    expect(good.querySelector("svg")!.getAttribute("fill")).toBe("currentColor");
    expect(screen.getByRole("button", { name: "Bad build" }).querySelector("svg")!.getAttribute("fill")).toBe("none");
  });
});
