import { describe, it, expect, vi } from "vitest";
import { createSiteDeployHandler, memoryCheckpoints, type SiteDeployDeps } from "../site-deploy";
import { checkSiteContent, SIGNED_IMAGE_PATH, IDEA_IMAGE_BUCKET } from "../site-content-check";
import type { SiteRow, SiteSandbox, StagedDeploy } from "../contract";
import { fakeGenerations, fakeSiteStore, siteRow, T1 } from "./fake-site-store";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/vite-react-supabase/template-files.generated";
import { CHAT_IMAGE_BUCKET } from "@/services/chat-images/store-chat-image";
import { IDEA_IMAGE_URL_TTL_SECONDS } from "@/services/onboarding/idea-reference-images";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const SHA = "abcdef1234567";
const LIVE = "1111111aaaa";

const BRANDED = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Paws &amp; Suds | Dog grooming in Leeds</title>
    <meta content="Book a dog groom in Leeds in two minutes." name="description" />
    <meta property="og:title" content="Paws &amp; Suds" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body><div id="root"></div></body>
</html>`;

const SIGNED = `https://wmyc.supabase.co${SIGNED_IMAGE_PATH}t1/ref.jpg?token=eyJhbGciOi.secret`;

function activationState(site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">) {
  if (site.live_deploy_id === staged.deploy_id) return "live" as const;
  if (site.desired_sha !== staged.sha) return "superseded" as const;
  return "pending" as const;
}

type Scenario = {
  indexHtml?: string;
  grep?: { exitCode: number; stdout: string };
  keys?: { meta?: boolean; images?: boolean; brand?: boolean };
  site?: Partial<SiteRow>;
  light?: boolean;
  diff?: string;
  styles?: boolean;
  lightResult?: { ok: boolean; reason?: string; missing_text?: true; infra?: true };
  sandboxThrows?: boolean;
};

function setup(sc: Scenario = {}) {
  const { store, sites } = fakeSiteStore([siteRow({ id: A, label: "alpha", ...sc.site })]);
  const order: string[] = [];
  const commands: string[] = [];
  const run = vi.fn(async (cmd: string) => {
    commands.push(cmd);
    if (sc.sandboxThrows && (cmd.startsWith("git show") || cmd.startsWith("git grep") || cmd.includes(" -U0 "))) throw new Error("sandbox unreachable");
    if (cmd.startsWith("git ls-tree")) return { exitCode: 0, stdout: "", stderr: "" };
    if (cmd === `git show ${SHA}:index.html`) {
      order.push("read-index");
      return { exitCode: 0, stdout: sc.indexHtml ?? BRANDED, stderr: "" };
    }
    if (cmd.startsWith("git grep")) {
      order.push("grep");
      return { ...(sc.grep ?? { exitCode: 1, stdout: "" }), stderr: "" };
    }
    if (cmd.startsWith("git diff") && cmd.includes(" -U0 ")) {
      order.push("scan-diff");
      return { exitCode: 0, stdout: sc.diff ?? "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const sandbox = { run, readFile: vi.fn(), listFiles: vi.fn() } as unknown as SiteSandbox;
  const kv: Record<string, string> = {};
  const runGate = vi.fn(async (i: { owner_link: string | null }) => {
    order.push("gate");
    return { ok: true, reason: "ok", evidence: "{}", owner_journey: i.owner_link ? ("passed" as const) : ("not_required" as const) };
  });
  const runLightGate = vi.fn(async () => {
    order.push("light-gate");
    return { reason: "ok", evidence: "", owner_journey: "not_required" as const, ...(sc.lightResult ?? { ok: true }) };
  });
  const requestActivate = vi.fn(async (i: { tenant_id: string; site_id: string; deploy_id: string; sha: string }) => {
    order.push("activate");
    if (await store.activateIfDesired(i.tenant_id, i.site_id, i.sha, i.deploy_id, "https://alpha.zaviagent.com")) kv.host = i.deploy_id;
  });
  const keys = { meta: true, images: true, brand: true, ...sc.keys };
  const deps: SiteDeployDeps = {
    store,
    sandboxes: { forSite: vi.fn(async () => sandbox) },
    supabase: { applySql: vi.fn(async () => "applied" as const), verifyCatalog: vi.fn(async () => []) },
    publisher: {
      stage: vi.fn(async (i: { sha: string }) => {
        order.push("stage");
        return { deploy_id: "d00000000b-next0002", preview_url: "https://alpha.zaviagent.com/__zavi_preview/d/?t=1.abcdefghijklmnop", sha: i.sha };
      }),
      previewUrl: vi.fn(async () => "https://unused.example/"),
    },
    requestActivate,
    activationState,
    verifySiteDeploy: vi.fn(async (_h: string, id: string) => (kv.host === id ? ({ ok: true } as const) : ({ ok: false, error: "no" } as const))),
    generations: fakeGenerations(sites).generations,
    checkpoints: memoryCheckpoints(),
    runGate: runGate as unknown as SiteDeployDeps["runGate"],
    seedMetaCheckEnabled: vi.fn(async () => keys.meta),
    signedImageCheckEnabled: vi.fn(async () => keys.images),
    brandCheckEnabled: vi.fn(async () => keys.brand),
    lightGateEnabled: async () => sc.light === true,
    classifyChange: async () => ({ migrations_touched: false, light: { ok: true, tokens: ["Paws"], styles: sc.styles === true } }) as never,
    runLightGate: runLightGate as unknown as SiteDeployDeps["runLightGate"],
    sleep: async () => {},
    activationWaitMs: 0,
  };
  const handler = createSiteDeployHandler(deps);
  const step = () => handler.step({ tenant_id: T1, conductor_run_id: "run-1", site_id: A, sha: SHA, attempt: 0 });
  return { step, order, commands, runGate, runLightGate, requestActivate, sites, kv };
}

describe("new-flow site check: starter page details", () => {
  it("a site that kept the starter title and description is sent back for a fix and never published", async () => {
    const t = setup({ indexHtml: TEMPLATE_FILES["index.html"] });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    const signal = (out as { signal: string }).signal;
    expect(signal).toContain('"New site"');
    expect(signal).toContain("meta description is still the starter text");
    expect(signal).toContain("og:title");
    expect(signal).toContain("public/favicon.svg");
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.kv).toEqual({});
    expect(t.sites[0].last_error).toContain("check: the site still has starter page details");
  });

  it("a site with its own title and description goes on to the full gate and live", async () => {
    const t = setup();
    const out = await t.step();
    expect(out.kind).toBe("live");
    expect(t.order).toEqual(["stage", "read-index", "grep", "gate", "activate"]);
  });

  it("a page with no description at all is also sent back", async () => {
    const t = setup({ indexHtml: BRANDED.replace(/<meta content="Book[^>]*>/, "") });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect((out as { signal: string }).signal).toContain("no meta description");
  });

  it("with site_meta_and_404 off the starter title goes live as before and index.html is never read", async () => {
    const t = setup({ indexHtml: TEMPLATE_FILES["index.html"], keys: { meta: false } });
    const out = await t.step();
    expect(out.kind).toBe("live");
    expect(t.commands.some((c) => c.includes(":index.html"))).toBe(false);
  });
});

describe("new-flow site check: founder images by signed link", () => {
  it("code that still points at a signed idea-image link is sent back with the download rule", async () => {
    const t = setup({ grep: { exitCode: 0, stdout: `${SHA}:src/pages/Home.tsx\n${SHA}:src/index.css\n` } });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    const signal = (out as { signal: string }).signal;
    expect(signal).toContain("src/pages/Home.tsx, src/index.css");
    expect(signal).toContain("public/reference/");
    expect(signal).not.toContain(SHA + ":");
    expect(t.runGate).not.toHaveBeenCalled();
    const grep = t.commands.find((c) => c.startsWith("git grep"))!;
    expect(grep).toContain(`'${SIGNED_IMAGE_PATH}' ${SHA}`);
    expect(grep).toContain(":(exclude)*.md");
  });

  it("the path it looks for is the bucket idea images are signed from", () => {
    expect(IDEA_IMAGE_BUCKET).toBe(CHAT_IMAGE_BUCKET);
    expect(SIGNED).toContain(`/storage/v1/object/sign/${CHAT_IMAGE_BUCKET}/`);
    expect(IDEA_IMAGE_URL_TTL_SECONDS).toBe(7 * 24 * 3600);
  });

  it("with site_images_downloaded off nothing is grepped", async () => {
    const t = setup({ grep: { exitCode: 0, stdout: `${SHA}:src/pages/Home.tsx\n` }, keys: { images: false } });
    const out = await t.step();
    expect(out.kind).toBe("live");
    expect(t.commands.some((c) => c.startsWith("git grep"))).toBe(false);
  });

  it("a grep that cannot run does not block the publish", async () => {
    const t = setup({ grep: { exitCode: 128, stdout: "" } });
    expect((await t.step()).kind).toBe("live");
  });

  it("a content check that cannot run at all fails the step instead of publishing a first build", async () => {
    const t = setup({ sandboxThrows: true });
    await expect(t.step()).rejects.toThrow("sandbox unreachable");
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.kv).toEqual({});
  });
});

describe("the B30 light gate is unaffected", () => {
  it("a light copy edit on a live site still takes the light check without the content check", async () => {
    const t = setup({
      indexHtml: TEMPLATE_FILES["index.html"],
      grep: { exitCode: 0, stdout: `${SHA}:src/pages/Home.tsx\n` },
      light: true,
      site: { status: "live", live_sha: LIVE, live_deploy_id: "d00000000a-live0001", desired_sha: LIVE },
    });
    const out = await t.step();
    expect(out.kind).toBe("live");
    expect(t.order).toContain("light-gate");
    expect(t.order).not.toContain("read-index");
    expect(t.order).not.toContain("grep");
    expect(t.runGate).not.toHaveBeenCalled();
  });
});

describe("checkSiteContent", () => {
  it("reads attributes in any order and decodes entities", async () => {
    const run = vi.fn(async (cmd: string) =>
      cmd.startsWith("git show") ? { exitCode: 0, stdout: BRANDED, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" },
    );
    const res = await checkSiteContent({ sandbox: { run } as unknown as SiteSandbox, sha: SHA, seedMeta: true, signedImages: true });
    expect(res).toEqual({ ok: true });
  });

  it("refuses a sha that is not a commit id without running anything", async () => {
    const run = vi.fn();
    const res = await checkSiteContent({ sandbox: { run } as unknown as SiteSandbox, sha: "main; rm -rf /", seedMeta: true, signedImages: true });
    expect(res).toEqual({ ok: true });
    expect(run).not.toHaveBeenCalled();
  });
});

const LIVE_SITE: Partial<SiteRow> = { status: "live", live_sha: LIVE, live_deploy_id: "d00000000a-live0001", desired_sha: LIVE };

function diffAdding(path: string, added: string[], removed: string[] = []): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -3,${removed.length} +3,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    "",
  ].join("\n");
}

describe("first-publish brand check follows the setting that tells the build to add the tags", () => {
  const brandOf = (t: ReturnType<typeof setup>) => (t.runGate.mock.calls[0]?.[0] as { brand_checks?: boolean } | undefined)?.brand_checks;

  it("with the page-details setting off the build is never told to add share tags, so the brand check does not run", async () => {
    const t = setup({ keys: { meta: false, images: false, brand: true } });
    expect((await t.step()).kind).toBe("live");
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(brandOf(t)).toBe(false);
  });

  it("with both settings on the first publish runs the brand check, and with the brand setting off it does not", async () => {
    const on = setup({ keys: { meta: true, brand: true } });
    await on.step();
    expect(brandOf(on)).toBe(true);
    const off = setup({ keys: { meta: true, brand: false } });
    await off.step();
    expect(brandOf(off)).toBe(false);
  });
});

describe("content checks on a site that already went live (DEL-1323 review)", () => {
  it("an existing live site with no meta description and an expired signed link publishes an unrelated full-gate edit with no content repair", async () => {
    const t = setup({
      indexHtml: BRANDED.replace(/<meta content="Book[^>]*>/, ""),
      grep: { exitCode: 0, stdout: `${SHA}:src/pages/Home.tsx\n` },
      diff: diffAdding("src/lib/hours.ts", ["export const OPEN = 9;"], ["export const OPEN = 8;"]),
      site: LIVE_SITE,
    });
    const out = await t.step();
    expect(out.kind).toBe("live");
    expect(t.order).toEqual(["stage", "scan-diff", "gate", "activate"]);
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.sites[0].last_error ?? null).toBeNull();
  });

  it("a first build still fails on the starter title even with its own description", async () => {
    const t = setup({ indexHtml: BRANDED.replace(/<title>[^<]*<\/title>/, "<title>New site</title>") });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect((out as { signal: string }).signal).toContain('starter title "New site"');
    expect((out as { signal: string }).signal).not.toContain("meta description");
    expect(t.requestActivate).not.toHaveBeenCalled();
  });

  it("an edit that adds a signed link in a stylesheet is sent back before the light gate and never published", async () => {
    const t = setup({
      light: true,
      diff: diffAdding("src/index.css", [`.hero { background-image: url("${SIGNED}"); }`]),
      site: LIVE_SITE,
    });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect((out as { signal: string }).signal).toContain("temporary signed link (src/index.css)");
    expect(t.runLightGate).not.toHaveBeenCalled();
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.kv).toEqual({});
    const scan = t.commands.find((c) => c.includes(" -U0 "))!;
    expect(scan).toContain(`${LIVE} ${SHA}`);
    expect(scan).toContain(":(exclude)*.md");
  });

  it("an edit that adds a signed og:image in index.html is sent back too", async () => {
    const t = setup({
      light: true,
      diff: diffAdding("index.html", [`    <meta property="og:image" content="${SIGNED}" />`]),
      site: LIVE_SITE,
    });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect((out as { signal: string }).signal).toContain("(index.html)");
    expect(t.runLightGate).not.toHaveBeenCalled();
  });

  it("a signed link the edit removes, or one only in an untouched file, does not block the edit", async () => {
    const t = setup({
      light: true,
      grep: { exitCode: 0, stdout: `${SHA}:src/pages/Home.tsx\n` },
      diff: diffAdding("src/pages/Home.tsx", ['<img src="/reference/a.jpg" />'], [`<img src="${SIGNED}" />`]),
      site: LIVE_SITE,
    });
    const out = await t.step();
    expect(out.kind).toBe("live");
    expect(t.order).toEqual(["stage", "scan-diff", "light-gate", "activate"]);
  });
});

describe("light gate and the phone width check (DEL-1323 review)", () => {
  it("a style edit takes the full gate, whose runner checks phone width, and never the light gate", async () => {
    const t = setup({ light: true, styles: true, site: LIVE_SITE });
    const out = await t.step();
    expect(out.kind).toBe("live");
    expect(t.runLightGate).not.toHaveBeenCalled();
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.order).toEqual(["stage", "scan-diff", "gate", "activate"]);
  });

  it("a text-only edit takes the light gate", async () => {
    const t = setup({ light: true, styles: false, site: LIVE_SITE });
    expect((await t.step()).kind).toBe("live");
    expect(t.runLightGate).toHaveBeenCalledTimes(1);
    expect(t.runGate).not.toHaveBeenCalled();
  });
});

describe("light gate that cannot reach the preview (DEL-1323 review)", () => {
  it("falls through to the full gate instead of a code repair, and publishes on its pass", async () => {
    const t = setup({
      light: true,
      lightResult: { ok: false, reason: "the home page could not be loaded: getaddrinfo EAI_AGAIN", infra: true },
      site: LIVE_SITE,
    });
    const out = await t.step();
    expect(out.kind).toBe("live");
    expect(t.order).toEqual(["stage", "scan-diff", "light-gate", "gate", "activate"]);
    expect(t.sites[0].last_error ?? null).toBeNull();
  });

  it("a broken asset is still a repair that never reaches the full gate", async () => {
    const t = setup({ light: true, lightResult: { ok: false, reason: "/assets/index-AbC.js answered 404" }, site: LIVE_SITE });
    const out = await t.step();
    expect(out.kind).toBe("repair");
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.requestActivate).not.toHaveBeenCalled();
  });
});
