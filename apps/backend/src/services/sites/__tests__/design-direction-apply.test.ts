import { describe, expect, it, vi } from "vitest";
import { THEME_CSS_PATH, renderThemeCss } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";
import type { SiteRow } from "../contract";
import type { DesignBrief } from "../design-brief";
import { designDirections, directionInThemeCss, fallbackDesignBrief, presetBriefColors, type ThemeMode } from "../design-directions";
import {
  applyDirectionInSandbox,
  enforceSiteTheme,
  pickWindow,
  type PushedFile,
  scheduleDirectionApply,
  type DirectionSandbox,
} from "../design-direction-apply";
import type { SiteDesignRow, SiteDesignStore } from "../site-design-store";

const BRIEF: DesignBrief = fallbackDesignBrief({ idea: "A family dentist; patients book check-ups online." });
const DIRS = designDirections(BRIEF);
const ALT = DIRS[1].id;

function row(over: Partial<SiteDesignRow> = {}): SiteDesignRow {
  return {
    site_id: "s1",
    tenant_id: "t1",
    conductor_run_id: "r1",
    brief: BRIEF,
    directions: DIRS,
    theme_mode: "theme_css",
    chosen_direction: "brand",
    chosen_at: null,
    applied_direction: "brand",
    sealed_at: null,
    journey_fix_claimed_at: null,
    journey_fix_conductor_run_id: null,
    fidelity: null,
    updated_at: null,
    ...over,
  };
}

const site = { id: "s1", github_full_name: "Praxis-build/smile-1", live_sha: null, status: "building" } as unknown as SiteRow;

function fakeSandbox(files: Record<string, string>, id: string | null = "sbx"): DirectionSandbox & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    sandboxFor: vi.fn(async () => id),
    read: vi.fn(async (_id: string, path: string) => files[path] ?? ""),
    write: vi.fn(async (_id: string, path: string, content: string) => {
      files[path] = content;
      writes.push(path);
    }),
    plainFile: vi.fn(async () => true),
  };
}

const graph = (status: string) => [
  { status: "done", payload: { stage: "provision" } },
  { status, payload: { stage: "build", fast_single_pass: true } },
  { status: "pending", payload: { stage: "deploy" } },
];

describe("pickWindow", () => {
  it("is open while the build step is pending or running on a never-live site", () => {
    expect(pickWindow({ runStatus: "active", goalGraph: graph("pending"), site })).toBeNull();
    expect(pickWindow({ runStatus: "active", goalGraph: graph("dispatched"), site })).toBeNull();
    expect(pickWindow({ runStatus: "provisioning", goalGraph: [], site: { ...site, status: "provisioning" } })).toBeNull();
  });

  it("closes once the build is pushed, the run ended or the site went live", () => {
    expect(pickWindow({ runStatus: "active", goalGraph: graph("done"), site })).toBe("built");
    expect(pickWindow({ runStatus: "failed", goalGraph: graph("dispatched"), site })).toBe("ended");
    expect(pickWindow({ runStatus: "active", goalGraph: graph("pending"), site: { ...site, live_sha: "a".repeat(40) } })).toBe("live");
  });
});

describe("applyDirectionInSandbox (the live preview restyle)", () => {
  it("writes the picked look's theme.css into the build sandbox and nothing else", async () => {
    const files: Record<string, string> = { [`/home/user/repo/${THEME_CSS_PATH}`]: renderThemeCss(DIRS[0].preset) };
    const sb = fakeSandbox(files);
    const out = await applyDirectionInSandbox({ tenant_id: "t1", site, brief: BRIEF, directions: DIRS, direction_id: ALT, theme_mode: "theme_css" }, sb);
    expect(out).toBe("applied");
    expect(sb.writes).toEqual([`/home/user/repo/${THEME_CSS_PATH}`]);
    expect(directionInThemeCss(files[`/home/user/repo/${THEME_CSS_PATH}`])).toBe(ALT);
  });

  it("never writes through a symlink, and an older starter or an unknown look is unsupported", async () => {
    const sb = fakeSandbox({});
    (sb.plainFile as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await applyDirectionInSandbox({ tenant_id: "t1", site, brief: BRIEF, directions: DIRS, direction_id: ALT, theme_mode: "theme_css" }, sb)).toBe("unsupported");
    expect(sb.writes).toEqual([]);
    for (const [mode, id] of [["index_css", ALT], ["theme_css", "nope"]] as Array<[ThemeMode, string]>) {
      expect(await applyDirectionInSandbox({ tenant_id: "t1", site, brief: BRIEF, directions: DIRS, direction_id: id, theme_mode: mode }, fakeSandbox({}))).toBe("unsupported");
    }
  });

  it("answers no_sandbox before the build's sandbox is up", async () => {
    expect(await applyDirectionInSandbox({ tenant_id: "t1", site, brief: BRIEF, directions: DIRS, direction_id: ALT, theme_mode: "theme_css" }, fakeSandbox({}, null))).toBe("no_sandbox");
  });
});

describe("scheduleDirectionApply", () => {
  function store(r: SiteDesignRow | (() => SiteDesignRow)): SiteDesignStore & { applied: string[] } {
    const applied: string[] = [];
    return {
      applied,
      get: vi.fn(async () => (typeof r === "function" ? r() : r)),
      createIfAbsent: vi.fn(),
      choose: vi.fn(),
      markApplied: vi.fn(async (_t: string, _s: string, d: string) => {
        applied.push(d);
      }),
      recordFidelity: vi.fn(),
    } as unknown as SiteDesignStore & { applied: string[] };
  }

  it("retries until the sandbox is up, then writes and marks the look applied", async () => {
    let up = false;
    const sb = fakeSandbox({});
    (sb.sandboxFor as ReturnType<typeof vi.fn>).mockImplementation(async () => (up ? "sbx" : null));
    const st = store(row({ chosen_direction: ALT }));
    const sleep = vi.fn(async () => {
      up = true;
    });
    const out = await scheduleDirectionApply({ tenant_id: "t1", site, direction_id: ALT }, { store: st, stillOpen: async () => true, sandbox: sb, sleep });
    expect(out).toBe("applied");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(st.applied).toEqual([ALT]);
  });

  it("an older call writes the CURRENT pick (converges), and nothing is written once the window closed", async () => {
    const files: Record<string, string> = {};
    const newer = store(row({ chosen_direction: "brand" }));
    expect(await scheduleDirectionApply({ tenant_id: "t1", site, direction_id: ALT }, { store: newer, stillOpen: async () => true, sandbox: fakeSandbox(files) })).toBe("superseded");
    expect(directionInThemeCss(files[`/home/user/repo/${THEME_CSS_PATH}`])).toBe("brand");
    const sb = fakeSandbox({});
    expect(await scheduleDirectionApply({ tenant_id: "t1", site, direction_id: ALT }, { store: store(row({ chosen_direction: ALT })), stillOpen: async () => false, sandbox: sb })).toBe("closed");
    expect(sb.writes).toEqual([]);
  });

  it("two tabs: a newer pick landing during the write is written after it, and only the newer one is marked", async () => {
    let reads = 0;
    const st = store(() => (++reads === 1 ? row({ chosen_direction: ALT }) : row({ chosen_direction: "brand" })));
    const files: Record<string, string> = {};
    const out = await scheduleDirectionApply({ tenant_id: "t1", site, direction_id: ALT }, { store: st, stillOpen: async () => true, sandbox: fakeSandbox(files) });
    expect(out).toBe("superseded");
    expect(st.applied).toEqual(["brand"]);
    expect(directionInThemeCss(files[`/home/user/repo/${THEME_CSS_PATH}`])).toBe("brand");
  });

  it("a sealed look is never rewritten in the preview", async () => {
    const sb = fakeSandbox({});
    const out = await scheduleDirectionApply(
      { tenant_id: "t1", site, direction_id: ALT },
      { store: store(row({ chosen_direction: ALT, sealed_at: "2026-10-07T00:00:00Z" })), stillOpen: async () => true, sandbox: sb },
    );
    expect(out).toBe("closed");
    expect(sb.writes).toEqual([]);
  });

  it("gives up after its tries without throwing", async () => {
    const out = await scheduleDirectionApply(
      { tenant_id: "t1", site, direction_id: ALT },
      { store: store(row({ chosen_direction: ALT })), stillOpen: async () => true, sandbox: fakeSandbox({}, null), sleep: async () => undefined, tries: 3 },
    );
    expect(out).toBe("gave_up");
  });
});

describe("enforceSiteTheme (the pushed commit carries the pick)", () => {
  const get = (r: SiteDesignRow | null) => ({ get: vi.fn(async () => r), seal: vi.fn(async () => (r ? { ...r, sealed_at: "2026-10-07T00:00:00Z" } : null)) });
  const pushed = (): PushedFile[] => [{ path: "src/pages/Home.tsx", action: "create", diff: "", content: "x" }];

  it("adds theme.css rendered from the picked look", async () => {
    const files = pushed();
    expect(await enforceSiteTheme({ tenant_id: "t1", site_id: "s1", files }, get(row({ chosen_direction: ALT })))).toBe(ALT);
    const theme = files.find((f) => f.path === THEME_CSS_PATH)!;
    expect(directionInThemeCss(theme.content!)).toBe(ALT);
  });

  it("replaces an engineer edit (or delete) of theme.css with the platform's render", async () => {
    const files: PushedFile[] = [...pushed(), { path: THEME_CSS_PATH, action: "delete", diff: "-" }];
    await enforceSiteTheme({ tenant_id: "t1", site_id: "s1", files }, get(row()));
    const theme = files.filter((f) => f.path === THEME_CSS_PATH);
    expect(theme).toHaveLength(1);
    expect(theme[0].action).toBe("modify");
    expect(directionInThemeCss(theme[0].content!)).toBe("brand");
  });

  it("leaves the files alone when the seed already carries the look, or the site cannot switch (never sealing it)", async () => {
    for (const r of [row(), row({ theme_mode: "index_css", chosen_direction: ALT }), null]) {
      const files = pushed();
      const st = get(r);
      await enforceSiteTheme({ tenant_id: "t1", site_id: "s1", files }, st);
      expect(files.map((f) => f.path)).toEqual(["src/pages/Home.tsx"]);
      expect(st.seal).toHaveBeenCalledTimes(r?.theme_mode === "theme_css" ? 1 : 0);
    }
  });

  it("uses the pick the seal returned, not the one read before it", async () => {
    const files = pushed();
    const st = { get: vi.fn(async () => row()), seal: vi.fn(async () => row({ chosen_direction: ALT, sealed_at: "2026-10-07T00:00:00Z" })) };
    expect(await enforceSiteTheme({ tenant_id: "t1", site_id: "s1", files }, st)).toBe(ALT);
  });
});

describe("the logo mark follows the chosen look", () => {
  const MARKED: DesignBrief = { ...BRIEF, logo: { icon: "leaf", shape: "rounded" } };
  const get = (r: SiteDesignRow) => ({ get: vi.fn(async () => r), seal: vi.fn(async () => ({ ...r, sealed_at: "2026-10-07T00:00:00Z" })) });
  const pushed = (): PushedFile[] => [{ path: "src/pages/Home.tsx", action: "create", diff: "", content: "x" }];

  it("pushes the mark and favicon in the picked look's colours", async () => {
    const files = pushed();
    await enforceSiteTheme({ tenant_id: "t1", site_id: "s1", files }, get(row({ brief: MARKED, chosen_direction: ALT })));
    const logo = files.find((f) => f.path === "public/images/logo.svg")!;
    const favicon = files.find((f) => f.path === "public/favicon.svg")!;
    const c = presetBriefColors(DIRS[1].preset);
    expect(logo.content).toContain('data-zavi-logo="mark"');
    expect(logo.content).toContain(`stroke="${c.primary}"`);
    expect(logo.content).not.toContain("<rect");
    expect(favicon.content).toContain('data-zavi-logo="mark"');
    expect(favicon.content).toContain(`<rect width="64" height="64" rx="14" fill="${c.primary}"/>`);
    expect(favicon.content).toContain(`stroke="${c["primary-foreground"]}"`);
  });

  it("keeps a logo or favicon the build wrote, and adds nothing for a site without the mark", async () => {
    const own: PushedFile = { path: "public/images/logo.svg", action: "modify", diff: "", content: "<svg>own</svg>" };
    const files = [...pushed(), own];
    await enforceSiteTheme({ tenant_id: "t1", site_id: "s1", files }, get(row({ brief: MARKED, chosen_direction: ALT })));
    expect(files.filter((f) => f.path === "public/images/logo.svg")).toEqual([own]);
    expect(files.some((f) => f.path === "public/favicon.svg")).toBe(true);

    const plain = pushed();
    await enforceSiteTheme({ tenant_id: "t1", site_id: "s1", files: plain }, get(row({ chosen_direction: ALT })));
    expect(plain.some((f) => f.path.includes("logo") || f.path.includes("favicon"))).toBe(false);
  });

  it("redraws the mark in the live preview, leaving a logo that is no longer Zavi's alone", async () => {
    const files: Record<string, string> = {
      "/home/user/repo/public/images/logo.svg": '<svg data-zavi-logo="mark">old</svg>',
      "/home/user/repo/public/favicon.svg": "<svg>the founder's own</svg>",
    };
    const sb = fakeSandbox(files);
    await applyDirectionInSandbox(
      { tenant_id: "t1", site, brief: MARKED, directions: DIRS, direction_id: ALT, theme_mode: "theme_css" },
      sb,
    );
    expect(sb.writes.some((p) => p.endsWith("public/images/logo.svg"))).toBe(true);
    expect(sb.writes.some((p) => p.endsWith("public/favicon.svg"))).toBe(false);
  });

  it("redraws a letter mark in the live preview too", async () => {
    const files: Record<string, string> = {
      "/home/user/repo/public/images/logo.svg": '<svg data-zavi-logo="letters">old</svg>',
      "/home/user/repo/public/favicon.svg": '<svg data-zavi-logo="letters">old</svg>',
    };
    const sb = fakeSandbox(files);
    const lettered = { ...MARKED, logo: { icon: null, shape: "rounded", letters: "SD" } } as DesignBrief;
    await applyDirectionInSandbox({ tenant_id: "t1", site, brief: lettered, directions: DIRS, direction_id: ALT, theme_mode: "theme_css" }, sb);
    const c = presetBriefColors(DIRS[1].preset);
    expect(files["/home/user/repo/public/images/logo.svg"]).toContain(`fill="${c.primary}"`);
    expect(files["/home/user/repo/public/favicon.svg"]).toContain(">SD</text>");
  });

  it("redraws the header mark and the favicon tile in the live preview, each as its own file", async () => {
    const files: Record<string, string> = {
      "/home/user/repo/public/images/logo.svg": '<svg data-zavi-logo="mark">old</svg>',
      "/home/user/repo/public/favicon.svg": '<svg data-zavi-logo="mark">old</svg>',
    };
    const sb = fakeSandbox(files);
    await applyDirectionInSandbox(
      { tenant_id: "t1", site, brief: MARKED, directions: DIRS, direction_id: ALT, theme_mode: "theme_css" },
      sb,
    );
    const c = presetBriefColors(DIRS[1].preset);
    const logo = files["/home/user/repo/public/images/logo.svg"]!;
    const favicon = files["/home/user/repo/public/favicon.svg"]!;
    expect(logo).toContain(`stroke="${c.primary}"`);
    expect(logo).not.toContain("<rect");
    expect(favicon).toContain(`<rect width="64" height="64" rx="14" fill="${c.primary}"/>`);
  });

  it("a letter-mark brief (initials, no icon) redraws its letters in the chosen look's colours", async () => {
    const lettered = { ...BRIEF, logo: { icon: null, shape: "rounded", letters: "SD" } } as DesignBrief;
    const files = pushed();
    await enforceSiteTheme({ tenant_id: "t1", site_id: "s1", files }, get(row({ brief: lettered, chosen_direction: ALT })));
    const logo = files.find((f) => f.path.endsWith("logo.svg"));
    expect(logo?.content).toContain(">SD</text>");
  });
});
