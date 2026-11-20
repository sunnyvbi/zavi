// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({}) }));

import { apiFetch } from "@/lib/api";
import { SiteDesignCard, SiteDesignCardView, lookFontsHref } from "./SiteDesignCard";
import {
  START_FAILED,
  START_OFFLINE,
  readSiteDesign,
  resetSharedSiteDesigns,
  shouldPollDesign,
  type SiteDesign,
  type SiteDesignLook,
} from "@/lib/workspace/useSiteDesign";

const RUN = "22222222-2222-4222-8222-222222222222";

function look(id: string, over: Partial<SiteDesignLook> = {}): SiteDesignLook {
  return {
    id,
    label: `${id[0]!.toUpperCase()}${id.slice(1)} look`,
    mood: `${id} mood`,
    recommended: id === "brand",
    fonts: { display: "Fraunces", body: "Inter" },
    swatches: { background: "#ffffff", foreground: "#111111", primary: "#2255aa", accent: "#ddeeff", muted: "#f3f3f3" },
    radius: "0.5rem",
    ...over,
  };
}

function design(over: Partial<SiteDesign> = {}): SiteDesign {
  return {
    run_id: RUN,
    source: "model",
    looks: [look("brand"), look("luxe", { fonts: { display: "Cormorant Garamond", body: "Lato" } }), look("studio")],
    chosen: "brand",
    applied: "brand",
    locked: null,
    plan: {
      audience: "Couples planning a wedding",
      positioning: null,
      tone: "calm",
      main_action: "Send an enquiry",
      sections: [
        { id: "hero", name: "Hero", headline: "Photographs that feel like the day did" },
        { id: "gallery", name: "Gallery", headline: "Recent weddings" },
      ],
      pages: [],
      facts: ["Weddings and portraits"],
    },
    checklist: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  resetSharedSiteDesigns();
  vi.mocked(apiFetch).mockReset();
  document.head.querySelectorAll("link[data-zavi-look-fonts]").forEach((l) => l.remove());
});

describe("SiteDesignCardView", () => {
  const building = (over: Partial<SiteDesign> = {}) => design({ picked: true, structure: "brand", ...over });

  it("a timed-out build keeps its compact look switch without restarting the picker", () => {
    const { container } = render(<SiteDesignCardView design={design({ awaiting_pick: false, picked: false, structure: null })} picking={null} pickError={null} onPick={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(screen.queryByTestId("look-build")).toBeNull();
  });

  it("while the build waits for a look the card is the picker: a tile only selects, nothing is sent", () => {
    const onPick = vi.fn();
    const onStart = vi.fn();
    render(<SiteDesignCardView design={design({ awaiting_pick: true })} picking={null} pickError={null} onPick={onPick} onStart={onStart} />);
    expect(screen.getByRole("heading").textContent).toBe("Pick a website");
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    expect(onPick).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByTestId("look-tile-luxe").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("look-build"));
    expect(onStart).toHaveBeenCalledWith("luxe");
    expect(screen.getByTestId("site-design-plan")).toBeTruthy();
    const summary = screen.getByTestId("site-design-plan").querySelector("summary")!;
    expect(summary.className).toContain("list-none");
    expect(summary.lastElementChild!.tagName.toLowerCase()).toBe("svg");
    expect(summary.lastElementChild!.getAttribute("class")).toContain("group-open/plan:rotate-90");
  });

  it("once building, looks remain switchable without the initial tile picker", () => {
    const { container } = render(<SiteDesignCardView design={building()} picking={null} pickError={null} onPick={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByTestId("website-variant")).toBeNull();
  });

  it("a settled site shows no look line at all: nothing to change, no orphan sentence", () => {
    for (const locked of ["built", "live", "ended", "unsupported"] as const) {
      const { container } = render(<SiteDesignCardView design={design({ locked, chosen: "luxe", applied: "luxe" })} picking={null} pickError={null} onPick={vi.fn()} />);
      expect(container.textContent).toBe("");
      expect(screen.queryByTestId("site-design")).toBeNull();
      expect(screen.queryByText(/Want a different feel/)).toBeNull();
      cleanup();
    }
  });

  it("still shows a pick error on its own", () => {
    render(<SiteDesignCardView design={building()} picking={null} pickError="Your pick did not save." onPick={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("Your pick did not save.");
  });
});

describe("helpers", () => {
  it("builds one fonts link for all looks and never a bad family", () => {
    const href = lookFontsHref([look("a"), look("b", { fonts: { display: "Bad<Font", body: "Lato" } })])!;
    expect(href).toContain("family=Fraunces:wght@400;700");
    expect(href).toContain("family=Lato:wght@400;700");
    expect(href).not.toContain("Bad");
  });

  it("reads a design defensively and polls only while a pick is awaited or its checklist is due", () => {
    expect(readSiteDesign({ design: { looks: "x" } })).toBeNull();
    const d = readSiteDesign({ design: { ...design(), looks: [look("brand"), { id: "x", label: "X", swatches: { background: "red" } }] } })!;
    expect(d.looks.map((l) => l.id)).toEqual(["brand"]);
    expect(shouldPollDesign(design({ awaiting_pick: true }), false)).toBe(true);
    expect(shouldPollDesign(design({ awaiting_pick: false, locked: null }), false)).toBe(true);
    expect(shouldPollDesign(design({ awaiting_pick: false, locked: null, checklist: null }), true)).toBe(true);
    expect(shouldPollDesign(design({ locked: "built" }), true)).toBe(true);
    expect(shouldPollDesign(design({ locked: "built" }), false)).toBe(false);
  });
});

describe("SiteDesignCard", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("renders nothing for a build without a brief", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("{}", { status: 404 }));
    const { container } = render(<SiteDesignCard runId={RUN} buildActive={false} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("a started build offers the switch without sending a pick automatically", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ design: design({ picked: true, structure: "brand" }) }));
    const { container } = render(<SiteDesignCard runId={RUN} buildActive />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => p === "/api/workspace/autopilot/site-design/direction")).toHaveLength(0);
  });
});

describe("SiteDesignCard while the build waits for a pick", () => {
  const THEME = ":root{--background: 255 255 255;--primary: 34 85 170}";
  const PREVIEW = { name: "Lumen", headline: "Photographs that feel like the day did", sections: [{ title: "Gallery", body: "Recent weddings" }] };
  const waiting = () =>
    design({
      awaiting_pick: true,
      preview: PREVIEW,
      looks: design().looks.map((l) => ({ ...l, theme_css: THEME, preview: PREVIEW })),
    });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const DIRECTION = "/api/workspace/autopilot/site-design/direction";
  const posts = () => vi.mocked(apiFetch).mock.calls.filter(([p]) => p === DIRECTION);

  function server(answers: Array<() => Response | Promise<Response>>) {
    let picked: string | null = null;
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === DIRECTION) {
        const answer = answers.shift();
        if (!answer) throw new Error("unexpected POST");
        const res = await answer();
        if (res.ok) picked = JSON.parse(String(init!.body)).direction;
        return res;
      }
      return json({ design: picked ? { ...waiting(), awaiting_pick: false, chosen: picked, applied: picked } : waiting() });
    });
  }

  it("never claims a look is building, preselects nothing and shows three rendered previews", async () => {
    server([]);
    render(<SiteDesignCard runId={RUN} buildActive />);
    await screen.findByTestId("look-tile-luxe");
    expect(screen.queryByText(/Building in the look selected below/)).toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("Pick a website");
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(screen.getByText("Recommended")).toBeTruthy();
    const frames = screen.getAllByTestId("website-variant").map((p) => p.querySelector("iframe")!.getAttribute("srcdoc")!);
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.includes(THEME) && f.includes(PREVIEW.headline))).toBe(true);
  });

  it("with a server deadline long past, shows no timer and never sends a pick on its own, and adds no filler paragraph", async () => {
    const stale = { ...waiting(), look_deadline_at: new Date(Date.now() - 60_000).toISOString(), look_deadline_in_ms: 0, look_wait_s: 30 };
    vi.mocked(apiFetch).mockImplementation(async () => json({ design: stale }));
    render(<SiteDesignCard runId={RUN} buildActive />);
    await screen.findByTestId("look-tile-luxe");
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(posts()).toHaveLength(0);
    expect(screen.queryByTestId("look-countdown")).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
    const card = screen.getByTestId("site-design");
    expect(card.textContent).toContain("Pick a website to start your build.");
    expect(card.textContent).not.toMatch(/starts in|starting in|starting “|starts right away|30 seconds|timer|switch while it builds|sample of your home page|final wording/i);
    expect([...card.querySelectorAll(":scope > p")].map((p) => p.textContent)).toEqual(["Design brief"]);
  });

  it("selecting tiles sends nothing; the button sends the selected look once and the card shows it building", async () => {
    server([() => json({ design: { ...waiting(), awaiting_pick: false, chosen: "luxe" }, started: true })]);
    render(<SiteDesignCard runId={RUN} buildActive />);
    await screen.findByTestId("look-tile-luxe");
    fireEvent.click(screen.getByTestId("look-tile-studio"));
    fireEvent.click(screen.getByTestId("look-tile-brand"));
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(posts()).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByTestId("look-build"));
    });
    await waitFor(() => expect(screen.queryByTestId("look-build")).toBeNull());
    expect(screen.queryByTestId("site-design")).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ run_id: RUN, direction: "luxe" });
    expect(screen.queryByTestId("look-build")).toBeNull();
    expect(screen.queryByText(/Building in the look selected below/)).toBeNull();
  });

  it("starts the recommended look too, even though the server already lists it as chosen", async () => {
    server([() => json({ design: { ...waiting(), awaiting_pick: false }, started: true })]);
    render(<SiteDesignCard runId={RUN} buildActive />);
    await screen.findByTestId("look-tile-brand");
    fireEvent.click(screen.getByTestId("look-tile-brand"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("look-build"));
    });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]!.body)).direction).toBe("brand");
  });

  it("posts once when the button is double-clicked in one tick", async () => {
    let release!: () => void;
    server([() => new Promise<Response>((r) => (release = () => r(json({ design: { ...waiting(), awaiting_pick: false, chosen: "studio" } }))))]);
    render(<SiteDesignCard runId={RUN} buildActive />);
    await screen.findByTestId("look-tile-studio");
    fireEvent.click(screen.getByTestId("look-tile-studio"));
    const build = screen.getByTestId("look-build");
    await act(async () => {
      build.click();
      build.click();
      build.click();
    });
    expect(posts()).toHaveLength(1);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByTestId("look-build")).toBeNull());
    expect(posts()).toHaveLength(1);
  });

  it("a 409 keeps the tiles and the selection with the server's reason, and a retry starts the build", async () => {
    server([
      () => json({ error: { code: "look_locked", message: "That look can not be picked right now." } }, 409),
      () => json({ design: { ...waiting(), awaiting_pick: false, chosen: "luxe" }, started: true }),
    ]);
    render(<SiteDesignCard runId={RUN} buildActive />);
    await screen.findByTestId("look-tile-luxe");
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("look-build"));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That look can not be picked right now."));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByTestId("look-tile-luxe").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("look-build") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId("look-build"));
    });
    await waitFor(() => expect(screen.queryByTestId("look-build")).toBeNull());
    expect(screen.queryByTestId("site-design")).toBeNull();
    expect(posts()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a 500 without a message and a dropped connection each keep the tiles with a plain error", async () => {
    server([() => new Response("oops", { status: 500 }), () => Promise.reject(new TypeError("Failed to fetch"))]);
    render(<SiteDesignCard runId={RUN} buildActive />);
    await screen.findByTestId("look-tile-studio");
    fireEvent.click(screen.getByTestId("look-tile-studio"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("look-build"));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(START_FAILED));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByTestId("look-build"));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(START_OFFLINE));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByTestId("site-look-line")).toBeNull();
    expect(posts()).toHaveLength(2);
  });

  it("two cards for the same run share one selection, post once, and both follow it to started", async () => {
    let release!: () => void;
    server([() => new Promise<Response>((r) => (release = () => r(json({ design: { ...waiting(), awaiting_pick: false, chosen: "studio" } }))))]);
    render(
      <>
        <div data-testid="chat">
          <SiteDesignCard runId={RUN} buildActive />
        </div>
        <div data-testid="pane">
          <SiteDesignCard runId={RUN} buildActive />
        </div>
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId("look-tile-luxe")).toHaveLength(2));
    const [chatLuxe, paneStudio] = [screen.getAllByTestId("look-tile-luxe")[0]!, screen.getAllByTestId("look-tile-studio")[1]!];
    fireEvent.click(chatLuxe);
    expect(screen.getAllByTestId("look-tile-luxe").map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    fireEvent.click(paneStudio);
    expect(screen.getAllByTestId("look-tile-studio").map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(screen.getAllByTestId("look-tile-luxe").map((t) => t.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    const [chatBuild, paneBuild] = screen.getAllByTestId("look-build");
    await act(async () => {
      fireEvent.click(chatBuild!);
    });
    await act(async () => {
      fireEvent.click(paneBuild!);
    });
    expect(posts()).toHaveLength(1);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryAllByTestId("look-build")).toHaveLength(0));
    expect(screen.queryAllByTestId("site-design")).toHaveLength(0);
    expect(screen.queryAllByTestId("look-build")).toHaveLength(0);
    expect(posts()).toHaveLength(1);
  });

  it("with the wait flag off the build never waits and still offers the switch", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ design: design({ looks: waiting().looks }) }));
    const { container } = render(<SiteDesignCard runId={RUN} buildActive />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId("look-build")).toBeNull();
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
});

describe("SiteDesignCard after a reload once the look was picked", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("after a reload a picked build offers the switch without sending anything", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ design: { ...design({ chosen: "luxe", applied: "luxe" }), awaiting_pick: false, picked: true } }));
    const { container } = render(<SiteDesignCard runId={RUN} buildActive />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(screen.queryByText(/you see selected/)).toBeNull();
    expect(vi.mocked(apiFetch).mock.calls.filter(([p]) => p === "/api/workspace/autopilot/site-design/direction")).toHaveLength(0);
  });

  it("a request-selected look remains switchable without the initial picker", () => {
    const { container } = render(<SiteDesignCardView design={design({ awaiting_pick: false, look_given: "idea" })} picking={null} pickError={null} onPick={() => undefined} onStart={() => undefined} />);
    expect(screen.getByTestId("site-look-change")).toBeTruthy();
    expect(screen.queryByTestId("look-build")).toBeNull();
  });

  it("reads structure, look_given and each preview's structure strictly", () => {
    const d = readSiteDesign({
      design: {
        ...design(),
        structure: "studio",
        look_given: "bogus",
        looks: [
          {
            ...design().looks[0],
            preview: { name: "A", headline: "H", hero_variant: "editorial", sections: [{ title: "T", kind: "Gallery", variant: "<b>", tone: "inverse" }] },
          },
        ],
      },
    })!;
    expect(d.structure).toBe("studio");
    expect(d.look_given).toBeNull();
    expect(d.looks[0]!.preview!.hero_variant).toBe("editorial");
    expect(d.looks[0]!.preview!.sections[0]).toEqual({ title: "T", body: undefined, kind: "Gallery", variant: undefined, tone: "inverse" });
  });

});

describe("readSiteDesign for the pick", () => {
  it("reads awaiting_pick strictly, drops oversized or non-string theme_css and malformed previews", () => {
    const base = design();
    const d = readSiteDesign({
      design: {
        ...base,
        awaiting_pick: "yes",
        preview: { name: "  ", headline: "x", sections: [] },
        looks: [
          { ...look("brand"), theme_css: ":root{}", preview: { name: "A", headline: "H", sections: [{ title: "" }, { title: "T", body: 3 }] } },
          { ...look("luxe"), theme_css: "x".repeat(64_001) },
          { ...look("studio"), theme_css: 42 },
        ],
      },
    })!;
    expect(d.awaiting_pick).toBe(false);
    expect(d.preview).toBeNull();
    expect(d.looks.map((l) => l.theme_css)).toEqual([":root{}", null, null]);
    expect(d.looks[0]!.preview!.sections).toEqual([{ title: "T", body: undefined }]);
    expect(readSiteDesign({ design: { ...base, awaiting_pick: true } })!.awaiting_pick).toBe(true);
    expect(d.picked).toBe(false);
    expect(readSiteDesign({ design: { ...base, picked: "true" } })!.picked).toBe(false);
    expect(readSiteDesign({ design: { ...base, picked: true } })!.picked).toBe(true);
    expect(shouldPollDesign({ ...base, awaiting_pick: true, locked: "built", checklist: { checked_at: "", found: 0, total: 0, items: [] } }, false)).toBe(true);
  });
});

it("switches an unlocked look using the existing pick action and disables pending picks", () => {
  const onPick = vi.fn();
  const props = { design: design({ awaiting_pick: false }), picking: null, pickError: null, onPick };
  const view = render(<SiteDesignCardView {...props} />);
  fireEvent.click(screen.getByTestId("site-look-change"));
  fireEvent.click(screen.getByRole("radio", { name: /Luxe look/ }));
  expect(onPick).toHaveBeenCalledWith("luxe");
  view.rerender(<SiteDesignCardView {...props} picking="luxe" />);
  for (const option of screen.getAllByRole("radio")) expect((option as HTMLButtonElement).disabled).toBe(true);
});

it("the picker never renders in the chat: the preview pane holds the only one", () => {
  const view = render(<SiteDesignCardView design={design({ awaiting_pick: true })} picking={null} pickError={null} onPick={vi.fn()} onStart={vi.fn()} inReplyGutter />);
  expect(screen.queryByTestId("site-design")).toBeNull();
  view.unmount();
  render(<SiteDesignCardView design={design({ awaiting_pick: true })} picking={null} pickError={null} onPick={vi.fn()} onStart={vi.fn()} />);
  expect(screen.getByTestId("site-design")).toBeTruthy();
});

it("reads the auto start time only while the build waits on a pick", () => {
  const base = { run_id: RUN, source: "model", looks: [look("brand"), look("luxe")], chosen: "brand", applied: "brand", locked: null, plan: design().plan, checklist: null };
  expect(readSiteDesign({ design: { ...base, awaiting_pick: true, auto_start_at: "2026-10-30T10:01:00.000Z" } })!.auto_start_at).toBe("2026-10-30T10:01:00.000Z");
  expect(readSiteDesign({ design: { ...base, awaiting_pick: false, auto_start_at: "2026-10-30T10:01:00.000Z" } })!.auto_start_at).toBeNull();
  expect(readSiteDesign({ design: { ...base, awaiting_pick: true, auto_start_at: "soon" } })!.auto_start_at).toBeNull();
  expect(readSiteDesign({ design: { ...base, awaiting_pick: true } })!.auto_start_at).toBeNull();
});

describe("the look switch while the site builds", () => {
  afterEach(() => cleanup());
  const building = () => design({ awaiting_pick: false, picked: true, chosen: "luxe", applied: "luxe" });
  const options = () => screen.queryAllByRole("radio");

  it("is a closed card naming the current look, never a native select", () => {
    const { container } = render(<SiteDesignCardView design={building()} picking={null} pickError={null} onPick={vi.fn()} onStart={vi.fn()} />);
    expect(container.querySelector("select, details, summary")).toBeNull();
    expect(screen.getByTestId("site-look-current").textContent).toBe("Luxe look");
    expect(screen.getByTestId("site-look-change").getAttribute("aria-expanded")).toBe("false");
    expect(options()).toHaveLength(0);
  });

  it("opens to every look with the current one checked, and closes again", () => {
    render(<SiteDesignCardView design={building()} picking={null} pickError={null} onPick={vi.fn()} onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId("site-look-change"));
    expect(screen.getByTestId("site-look-change").getAttribute("aria-expanded")).toBe("true");
    expect(options().map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(options().map((o) => o.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.click(screen.getByTestId("site-look-change"));
    expect(options()).toHaveLength(0);
  });

  it("switches to a different look once and never re-sends the current one", () => {
    const onPick = vi.fn();
    render(<SiteDesignCardView design={building()} picking={null} pickError={null} onPick={onPick} onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId("site-look-change"));
    fireEvent.click(screen.getByTestId("site-look-option-luxe"));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("site-look-option-studio"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("studio");
  });

  it("locks every look while a switch is in flight and shows which one is switching", () => {
    const onPick = vi.fn();
    render(<SiteDesignCardView design={building()} picking="studio" pickError={null} onPick={onPick} onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId("site-look-change"));
    for (const o of options()) expect((o as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("site-look-option-brand"));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("site-look-option-studio").querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByTestId("site-look-option-brand").querySelector(".animate-spin")).toBeNull();
  });

  it("shows a failed switch even while the card is closed", () => {
    render(<SiteDesignCardView design={building()} picking={null} pickError="Could not switch the look." onPick={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByTestId("site-look-change").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("alert").textContent).toBe("Could not switch the look.");
  });

  it("arrow keys move focus between looks and wrap", () => {
    render(<SiteDesignCardView design={building()} picking={null} pickError={null} onPick={vi.fn()} onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId("site-look-change"));
    fireEvent.keyDown(screen.getByTestId("site-look-option-luxe"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("site-look-option-studio"));
    fireEvent.keyDown(screen.getByTestId("site-look-option-studio"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("site-look-option-brand"));
    fireEvent.keyDown(screen.getByTestId("site-look-option-brand"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByTestId("site-look-option-studio"));
  });
});
