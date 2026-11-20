import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { SITE_REPO_DIR, type SiteRow, type SiteSandbox } from "../contract";
import { runDirectSiteChange, type DirectChangeDeps, type DirectChangePlan } from "../site-direct-change";
import {
  cleanImageRequest,
  imageFileOf,
  imagePlan,
  nearestAspect,
  nextSlug,
  prepareImage,
  rewriteImageRefs,
  type ImageReplaceDeps,
  type ImageReplaceOutcome,
} from "../site-image-replace";

const T = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const REPO = "praxis-build/harbor-plumbing";
const HEAD = "a".repeat(40);

const SITE = {
  id: SITE_ID,
  tenant_id: T,
  github_full_name: REPO,
  root_conductor_run_id: "bbbbbbbb-0000-4000-8000-000000000001",
} as unknown as SiteRow;

let dir = "";
const initial: Record<string, string> = {};

function put(rel: string, content: string | Buffer): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (typeof content === "string") initial[rel] = content;
}

function local(rel: string): string {
  return join(dir, rel.startsWith(`${SITE_REPO_DIR}/`) ? rel.slice(SITE_REPO_DIR.length + 1) : rel);
}

function localSandbox(): SiteSandbox {
  return {
    async run(cmd) {
      const r = spawnSync("bash", ["-c", `(set -e; ${cmd}\n)`], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    async readFile(p) {
      return readFileSync(local(p));
    },
    async listFiles(d) {
      return existsSync(local(d)) ? readdirSync(local(d)) : [];
    },
  };
}

function harness(over: Partial<DirectChangeDeps> = {}) {
  const released = vi.fn(async () => undefined);
  const commits: Array<Parameters<DirectChangeDeps["commit"]>[0]> = [];
  const deps: DirectChangeDeps = {
    claimLease: vi.fn(async () => ({ release: released })),
    hasActiveBuild: vi.fn(async () => false),
    sandboxFor: vi.fn(async () => localSandbox()),
    repoGate: vi.fn(async () => ({ ok: true, site_id: SITE_ID })),
    installation: vi.fn(async () => -1),
    mainHead: vi.fn(async () => HEAD),
    readMainFile: vi.fn(async (a) => {
      if (a.sha !== HEAD) return null;
      return a.path in initial ? initial[a.path]! : null;
    }),
    commit: vi.fn(async (a) => {
      commits.push(a);
      return { commit_sha: "c".repeat(40) };
    }),
    reserveChange: vi.fn(async () => undefined),
    finishChange: vi.fn(async () => undefined),
    dropChange: vi.fn(async () => undefined),
    markSiteEdited: vi.fn(async () => undefined),
    log: () => undefined,
    ...over,
  };
  return { deps, released, commits };
}

const PAGE = `import { Hero } from "../components/sections";
export default function Home() {
  return <Hero data-zavi-section="hero" image={{ src: "/images/hero-1600.webp", srcset: "/images/hero-1600.webp 1600w, /images/hero-800.webp 800w", width: 1600, height: 900, alt: "A plumber" }} />;
}
`;
const CSS = `.band { background: url(/images/hero-800.webp); }\n.other { background: url(/images/hero-800.webp.bak); }\n`;

async function photo(w: number, h: number, color: string): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).webp().toBuffer();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "zavi-direct-change-"));
  for (const k of Object.keys(initial)) delete initial[k];
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", `https://github.com/${REPO}.git`], { cwd: dir });
  put("src/pages/Home.tsx", PAGE);
  put("src/styles.css", CSS);
  put("public/images/hero-1600.webp", await photo(1600, 900, "#336699"));
  put("public/images/hero-800.webp", await photo(800, 450, "#336699"));
  put(
    "public/images/zavi-images.json",
    `${JSON.stringify(
      {
        version: 1,
        generated: 3,
        images: [
          { slug: "hero", src: "/images/hero-1600.webp", srcset: "/images/hero-1600.webp 1600w, /images/hero-800.webp 800w", width: 1600, height: 900, alt: "A plumber", aspect: "16:9" },
        ],
      },
      null,
      2,
    )}\n`,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const change = (plan: (s: SiteSandbox) => Promise<DirectChangePlan>, deps: DirectChangeDeps, site: SiteRow = SITE) =>
  runDirectSiteChange({ tenant_id: T, site, kind: "test", plan }, deps);

describe("runDirectSiteChange", () => {
  const edit = async (): Promise<DirectChangePlan> => ({
    files: [{ path: "src/styles.css", before: CSS, after: CSS.replace(".band", ".strip") }],
    label: "Changed a style",
  });

  it("writes the sandbox, commits on the head it read and records the change", async () => {
    const h = harness();
    const r = await change(edit, h.deps);
    expect(r).toEqual({ ok: true, commit_sha: "c".repeat(40), conductor_run_id: expect.any(String), files: ["src/styles.css"] });
    expect(h.deps.reserveChange).toHaveBeenCalledTimes(1);
    expect(h.deps.finishChange).toHaveBeenCalledWith(expect.objectContaining({ commit_sha: "c".repeat(40), label: "Changed a style" }));
    expect(readFileSync(join(dir, "src/styles.css"), "utf8")).toContain(".strip");
    expect(h.commits[0]).toMatchObject({ expected_parent_sha: HEAD, message: "Changed a style", files: [{ path: "src/styles.css", action: "modify" }] });
    expect(h.released).toHaveBeenCalled();
  });

  it("stops before writing when the site is busy, foreign or behind main", async () => {
    expect(await change(edit, harness({ claimLease: vi.fn(async () => ({ held: "edit" as const })) }).deps)).toEqual({ ok: false, reason: "lease_held" });
    expect(await change(edit, harness({ claimLease: vi.fn(async () => ({ held: "unknown" as const })) }).deps)).toEqual({ ok: false, reason: "lease_held" });
    expect(await change(edit, harness({ claimLease: vi.fn(async () => ({ held: "wake" as const })) }).deps)).toEqual({ ok: false, reason: "preview_starting" });
    expect(await change(edit, harness({ claimLease: vi.fn(async () => ({ held: "restart" as const })) }).deps)).toEqual({ ok: false, reason: "preview_starting" });
    expect(await change(edit, harness({ hasActiveBuild: vi.fn(async () => true) }).deps)).toEqual({ ok: false, reason: "build_active" });
    expect(await change(edit, harness({ repoGate: vi.fn(async () => ({ ok: true, site_id: "other" })) }).deps)).toEqual({ ok: false, reason: "repo_gate" });
    expect(await change(edit, harness().deps, { ...SITE, tenant_id: "x" } as SiteRow)).toEqual({ ok: false, reason: "not_your_site" });
    const stale = harness({ readMainFile: vi.fn(async () => "something newer") });
    expect(await change(edit, stale.deps)).toEqual({ ok: false, reason: "behind_main" });
    const down = harness({ readMainFile: vi.fn(async () => Promise.reject(new Error("read_file HTTP 502"))) });
    expect(await change(edit, down.deps)).toEqual({ ok: false, reason: "main_unreadable" });
    expect(readFileSync(join(dir, "src/styles.css"), "utf8")).toBe(CSS);
    spawnSync("git", ["remote", "set-url", "origin", "https://github.com/someone/else.git"], { cwd: dir });
    expect(await change(edit, harness().deps)).toEqual({ ok: false, reason: "foreign_tree" });
  });

  it("commits nothing when the change record cannot be written, and puts the preview back", async () => {
    const h = harness({ reserveChange: vi.fn(async () => Promise.reject(new Error("db down"))) });
    expect(await change(edit, h.deps)).toEqual({ ok: false, reason: "record_failed" });
    expect(h.commits).toHaveLength(0);
    expect(readFileSync(join(dir, "src/styles.css"), "utf8")).toBe(CSS);
  });

  it("refuses a path outside page source, theme and images", async () => {
    const r = await change(async () => ({ files: [{ path: "package.json", before: null, after: "{}" }], label: "x" }), harness().deps);
    expect(r).toEqual({ ok: false, reason: "unsafe_path" });
  });

  it("puts the sandbox back when the commit fails, removing new files", async () => {
    const h = harness({ commit: vi.fn(async () => Promise.reject(new Error("409 conflict"))) });
    const big = Buffer.alloc(120_000, 7).toString("base64");
    const r = await change(
      async () => ({
        files: [
          { path: "src/styles.css", before: CSS, after: `${CSS}\n.x{}` },
          { path: "public/images/new-1600.webp", before: null, after: big, encoding: "base64" },
        ],
        label: "x",
      }),
      h.deps,
    );
    expect(r).toEqual({ ok: false, reason: "persist_failed" });
    expect(h.deps.dropChange).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "src/styles.css"), "utf8")).toBe(CSS);
    expect(existsSync(join(dir, "public/images/new-1600.webp"))).toBe(false);
  });
});

describe("image replace", () => {
  function imageDeps(over: Partial<ImageReplaceDeps> = {}) {
    const generated: Array<{ task: string; prompt: string; reference_url?: string }> = [];
    const deps: ImageReplaceDeps = {
      configured: vi.fn(async () => true),
      estimate: vi.fn(async () => 0.05),
      afford: vi.fn(async () => "ok" as const),
      generate: vi.fn(async (task, req) => {
        generated.push({ task, prompt: req.prompt, reference_url: req.reference_url });
        return { ok: true as const, url: "https://cdn.example/x.png", cost_usd: 0.04, model: "test-model" };
      }),
      download: vi.fn(async () => new Uint8Array(await photo(2000, 1500, "#aa3322"))),
      fetchPublic: vi.fn(async () => new Uint8Array(await photo(1200, 1200, "#22aa33"))),
      shareReference: vi.fn(async () => ({ url: "https://signed.example/ref.png", done: vi.fn(async () => undefined) })),
      ...over,
    };
    return { deps, generated };
  }

  async function replace(text: string, mode: "generate" | "edit" | "url", deps: ImageReplaceDeps, src = "/images/hero-1600.webp") {
    const sandbox = localSandbox();
    const request = { src, mode, text };
    const prepared = await prepareImage(sandbox, { tenant_id: T, site_id: SITE_ID, request }, deps);
    if ("reason" in prepared) return { reason: prepared.reason };
    const outcome: { value: ImageReplaceOutcome | null } = { value: null };
    const h = harness();
    const r = await change(imagePlan(prepared, outcome), h.deps);
    return { r, outcome: outcome.value, commits: h.commits };
  }

  it("generates a new photo at the old shape and points every reference at it", async () => {
    const { deps, generated } = imageDeps();
    const out = await replace("a van parked outside a house at dusk", "generate", deps);
    if ("reason" in out) throw new Error(out.reason);
    expect(out.r.ok).toBe(true);
    expect(generated[0]!.task).toBe("image.hero");
    expect(out.outcome).toMatchObject({ src: "/images/hero-2-1600.webp", places: 4 });
    const page = readFileSync(join(dir, "src/pages/Home.tsx"), "utf8");
    expect(page).toContain('src: "/images/hero-2-1600.webp", srcset: "/images/hero-2-1600.webp 1600w, /images/hero-2-800.webp 800w"');
    const css = readFileSync(join(dir, "src/styles.css"), "utf8");
    expect(css).toContain("url(/images/hero-2-800.webp)");
    expect(css).toContain("url(/images/hero-800.webp.bak)");
    const meta = await sharp(readFileSync(join(dir, "public/images/hero-2-1600.webp"))).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 900]);
    const marker = JSON.parse(readFileSync(join(dir, "public/images/zavi-images.json"), "utf8"));
    expect(marker.generated).toBe(3);
    expect(marker.images.map((e: { slug: string; source?: string }) => [e.slug, e.source])).toEqual([["hero", undefined], ["hero-2", "edit"]]);
    expect(existsSync(join(dir, "public/images/hero-1600.webp"))).toBe(true);
    expect(out.commits[0]!.files.filter((f) => f.encoding === "base64").map((f) => f.path)).toEqual([
      "public/images/hero-2-1600.webp",
      "public/images/hero-2-800.webp",
    ]);
  });

  it("edits the current photo through a signed reference that is cleaned up", async () => {
    const done = vi.fn(async () => undefined);
    const { deps, generated } = imageDeps({ shareReference: vi.fn(async () => ({ url: "https://signed.example/ref.png", done })) });
    const out = await replace("make it a sunny morning", "edit", deps);
    if ("reason" in out) throw new Error(out.reason);
    expect(generated[0]).toMatchObject({ task: "image.edit", reference_url: "https://signed.example/ref.png" });
    expect(generated[0]!.prompt).toContain("make it a sunny morning");
    expect(done).toHaveBeenCalled();
  });

  it("imports a pasted photo without spending, cropped to the old shape", async () => {
    const { deps, generated } = imageDeps();
    const out = await replace("https://photos.example/van.jpg", "url", deps);
    if ("reason" in out) throw new Error(out.reason);
    expect(generated).toHaveLength(0);
    const marker = JSON.parse(readFileSync(join(dir, "public/images/zavi-images.json"), "utf8"));
    expect(marker.generated).toBe(3);
    expect(marker.images[1].source).toBe("link");
    const meta = await sharp(readFileSync(join(dir, "public/images/hero-2-1200.webp"))).metadata();
    expect(meta.width! / meta.height!).toBeCloseTo(16 / 9, 1);
  });

  it("refuses before paying when the wallet is short or unreadable, or the photo is not in the code", async () => {
    const m = JSON.parse(readFileSync(join(dir, "public/images/zavi-images.json"), "utf8"));
    writeFileSync(join(dir, "public/images/zavi-images.json"), JSON.stringify({ ...m, generated: 12 }));
    const short = imageDeps({ afford: vi.fn(async () => "short" as const) });
    expect(await replace("a new van", "generate", short.deps)).toEqual({ reason: "insufficient_credits" });
    expect(short.deps.afford).toHaveBeenCalledWith(T, 0.05);
    const unknown = imageDeps({ afford: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    expect(await replace("a new van", "edit", unknown.deps)).toEqual({ reason: "credits_unavailable" });
    expect(unknown.deps.shareReference).not.toHaveBeenCalled();
    const unpriced = imageDeps({ estimate: vi.fn(async () => 0) });
    expect(await replace("a new van", "generate", unpriced.deps)).toEqual({ reason: "credits_unavailable" });
    expect(unpriced.deps.afford).not.toHaveBeenCalled();
    const { deps, generated } = imageDeps();
    put("public/images/unused.webp", await photo(400, 400, "#000000"));
    expect(await replace("https://photos.example/a.jpg", "url", deps, "/images/unused.webp")).toEqual({ reason: "not_in_source" });
    expect(await replace("a new van", "generate", deps, "https://elsewhere.example/a.png")).toEqual({ reason: "not_a_site_image" });
    expect(generated).toHaveLength(0);
    expect(short.generated).toHaveLength(0);
  });

  it("a paid edit is not stopped by the free photos' cap, and carries what to charge", async () => {
    const m = JSON.parse(readFileSync(join(dir, "public/images/zavi-images.json"), "utf8"));
    writeFileSync(join(dir, "public/images/zavi-images.json"), JSON.stringify({ ...m, generated: 12 }));
    const { deps } = imageDeps();
    const prepared = await prepareImage(localSandbox(), { tenant_id: T, site_id: SITE_ID, request: { src: "/images/hero-1600.webp", mode: "generate", text: "a van at dusk" } }, deps);
    if ("reason" in prepared) throw new Error(prepared.reason);
    expect(prepared.charge).toEqual({ task: "image.hero", cost_usd: 0.04 });
    const free = await prepareImage(localSandbox(), { tenant_id: T, site_id: SITE_ID, request: { src: "/images/hero-1600.webp", mode: "url", text: "https://p.example/a.jpg" } }, deps);
    if ("reason" in free) throw new Error(free.reason);
    expect(free.charge).toBeNull();
  });

  it("starts over when the photo list changed while the photo was made", async () => {
    const { deps } = imageDeps();
    const sandbox = localSandbox();
    const prepared = await prepareImage(sandbox, { tenant_id: T, site_id: SITE_ID, request: { src: "/images/hero-1600.webp", mode: "url", text: "https://p.example/a.jpg" } }, deps);
    if ("reason" in prepared) throw new Error(prepared.reason);
    writeFileSync(join(dir, "public/images/zavi-images.json"), '{"version":1,"generated":5,"images":[]}\n');
    const r = await change(imagePlan(prepared, { value: null }), harness().deps);
    expect(r).toEqual({ ok: false, reason: "changed" });
  });
});

describe("image helpers", () => {
  it("parses only repo image paths", () => {
    expect(imageFileOf("/images/team-960.webp")).toBe("team-960.webp");
    expect(imageFileOf("/images/../secret.webp")).toBeNull();
    expect(imageFileOf("https://cdn.example/images/a.webp")).toBeNull();
    expect(imageFileOf("/assets/a.webp")).toBeNull();
  });

  it("validates requests", () => {
    expect(cleanImageRequest({ src: "/images/a.webp", mode: "generate", text: "  a calm   studio  " })).toEqual({ src: "/images/a.webp", mode: "generate", text: "a calm studio" });
    expect(cleanImageRequest({ src: "/images/a.webp", mode: "url", text: "http://x.example/a.png" })).toBeNull();
    expect(cleanImageRequest({ src: "/images/a.webp", mode: "edit", text: "x" })).toBeNull();
    expect(cleanImageRequest({ src: "/images/a.webp", mode: "paint", text: "a calm studio" })).toBeNull();
  });

  it("picks the next free name and the nearest shape", () => {
    expect(nextSlug("hero", new Set(["hero", "hero-2"]))).toBe("hero-3");
    expect(nextSlug("hero-3", new Set(["hero"]))).toBe("hero-2");
    expect(nextSlug("Team Photo.JPG", new Set())).toBe("team-photo-jpg-2");
    expect(nearestAspect(1920, 1080)).toBe("16:9");
    expect(nearestAspect(800, 1000)).toBe("4:5");
    expect(nearestAspect(1000, 1050)).toBe("1:1");
  });

  it("rewrites whole path tokens only", () => {
    const out = rewriteImageRefs([{ path: "src/a.tsx", content: 'x("/images/a.webp") y("/images/a.webp2") z("/cdn/images/a.webp")' }], new Map([["/images/a.webp", "/images/b.webp"]]));
    expect(out[0]!.after).toBe('x("/images/b.webp") y("/images/a.webp2") z("/cdn/images/a.webp")');
  });
});
