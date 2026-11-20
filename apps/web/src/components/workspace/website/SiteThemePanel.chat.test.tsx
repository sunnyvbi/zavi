// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({
  posts: [] as unknown[],
  applyGate: null as null | Promise<void>,
  refinesGate: null as null | Promise<void>,
  applyAnswer: null as null | { status: number; body: unknown },
  refines: [] as unknown[],
}));

const THEME = { name: "clean", colors: { primary: "#2563eb", background: "#ffffff", foreground: "#0f172a", accent: "#dbeafe" }, fonts: { display: "Inter", body: "Inter" }, radius: "0.5rem" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith("/api/website/site-design-edit?")) {
      return json({ theme: THEME, fonts: ["Inter", "Lato"], radii: ["0", "0.5rem"], section: null, section_message: null, image_ai: false });
    }
    if (url === "/api/website/site-design-edit" && init?.method === "POST") {
      api.posts.push(init.body ? JSON.parse(init.body) : null);
      if (api.applyGate) await api.applyGate;
      const answer = api.applyAnswer ?? { status: 200, body: { ok: true, commit_sha: "abc", conductor_run_id: "chg-theme", theme: { ...THEME, colors: { ...THEME.colors, primary: "#ff0000" } } } };
      return json(answer.body, answer.status);
    }
    if (url.includes("/refines?")) {
      if (api.refinesGate) await api.refinesGate;
      return json({ refines: api.refines });
    }
    return json({ run: { id: "b1", status: "done", updated_at: "2026-10-08T07:00:00.000Z" } });
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn() }));

import { SiteThemePanel } from "./SiteThemePanel";
import { useBuildSession } from "@/lib/workspace/useBuildSession";
import { resetSharedBuildReads } from "@/lib/workspace/useBuildPreview";
import { themeChangeLabel, useSiteEditsSession } from "@/lib/workspace/siteInlineEdits";

const T0 = Date.parse("2026-10-08T08:00:00.000Z");
const THEME_CHANGE = { id: "chg-theme", status: "done", message: "Changed the brand colour", created_at: new Date(T0 + 5_000).toISOString(), draft: true };
let seq = 0;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openPanel(sessionId: string | null) {
  const appId = `site:bbbbbbbb-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const session = renderHook(() => useBuildSession("b1", null));
  const binding = renderHook(() => useSiteEditsSession(appId, sessionId));
  render(<SiteThemePanel appId={appId} onClose={vi.fn()} />);
  await advance(0);
  await advance(0);
  fireEvent.change(screen.getByLabelText("Brand colour"), { target: { value: "#ff0000" } });
  return { session, binding };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  resetSharedBuildReads();
  api.posts = [];
  api.applyGate = null;
  api.refinesGate = null;
  api.applyAnswer = null;
  api.refines = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Theme Apply shows in the build chat at once", () => {
  it("puts the user's change and a working agent card in the chat before the server answers, then swaps for the real change", async () => {
    let release!: () => void;
    api.applyGate = new Promise<void>((r) => (release = r));
    const { session } = await openPanel("b1");
    expect(session.result.current.savingEdits).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await advance(0);
    expect(api.posts).toHaveLength(1);
    expect(session.result.current.savingEdits.map((r) => ({ message: r.message, status: r.status }))).toEqual([
      { message: "Changed the brand colour", status: "saving" },
    ]);
    expect(session.result.current.refines).toEqual([]);

    let releaseRefines!: () => void;
    api.refinesGate = new Promise<void>((r) => (releaseRefines = r));
    api.refines = [THEME_CHANGE];
    await act(async () => release());
    await advance(0);
    expect(session.result.current.savingEdits.map((r) => r.status)).toEqual(["saved"]);

    api.refinesGate = null;
    await act(async () => releaseRefines());
    await advance(0);
    expect(session.result.current.refines.map((r) => r.id)).toEqual(["chg-theme"]);
    expect(session.result.current.savingEdits).toEqual([]);
  });

  it("a failed apply leaves no working card: it turns into the server's reason", async () => {
    api.applyAnswer = { status: 422, body: { error: { code: "behind_main", message: "Your site changed while saving. Try again." } } };
    const { session } = await openPanel("b1");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await advance(0);
    await advance(0);
    expect(session.result.current.savingEdits.map((r) => ({ status: r.status, failure: r.failure_message }))).toEqual([
      { status: "failed", failure: "Your site changed while saving. Try again." },
    ]);
    expect(session.result.current.refines).toEqual([]);
    await advance(60_000);
    expect(session.result.current.savingEdits.map((r) => r.status)).toEqual(["failed"]);
  });

  it("a panel whose site is not open in a build chat posts nothing to any chat", async () => {
    const { session } = await openPanel(null);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await advance(0);
    expect(api.posts).toHaveLength(1);
    expect(session.result.current.savingEdits).toEqual([]);
  });

  it("stops posting to a chat once that chat lets go of the site", async () => {
    const { session, binding } = await openPanel("b1");
    binding.unmount();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await advance(0);
    expect(session.result.current.savingEdits).toEqual([]);
  });
});

describe("themeChangeLabel", () => {
  it("says what changed in a few words", () => {
    expect(themeChangeLabel({ colors: { primary: "#000000" } })).toBe("Changed the brand colour");
    expect(themeChangeLabel({ colors: { primary: "#000000", accent: "#111111" } })).toBe("Changed the colours");
    expect(themeChangeLabel({ fonts: { display: "Lato" } })).toBe("Changed the heading font");
    expect(themeChangeLabel({ fonts: { display: "Lato", body: "Lato" }, radius: "1rem" })).toBe("Changed the fonts and corners");
    expect(themeChangeLabel({ colors: { background: "#000000" }, fonts: { body: "Lato" }, radius: "0" })).toBe("Changed the page colour, body font and corners");
    expect(themeChangeLabel({})).toBe("Changed the theme");
  });
});
