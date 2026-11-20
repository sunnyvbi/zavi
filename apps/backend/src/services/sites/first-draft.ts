
import { createHash } from "node:crypto";
import { SITE_REPO_DIR } from "./contract";
import { parseSitePlan, type SitePlan } from "./design-brief";
import { isFastSinglePassPayload } from "@/services/agents/fast-build-prompt";
import { STARTER_PLACEHOLDER_HOME_PATH, zaviStarterProvider } from "@/services/provisioning/templates/vite-react-zavi";
import { viteStarterProvider } from "@/services/provisioning/templates/vite-react-supabase";

export const DRAFT_HOME_PATH: string = STARTER_PLACEHOLDER_HOME_PATH;

export const FIRST_DRAFT_DIR = "/home/user/.zavi-preview";
export const FIRST_DRAFT_PATH = `${FIRST_DRAFT_DIR}/first-draft.json`;
export const FIRST_DRAFT_HOME_ABS = `${SITE_REPO_DIR}/${DRAFT_HOME_PATH}`;

export const FIRST_DRAFT_VERSION = 1;
export const DRAFT_MAX_SECTIONS = 4;

export type FirstDraftSection = { name: string; text: string };
export type FirstDraftContent = {
  name: string;
  headline: string;
  subhead: string;
  action: { label: string; steps: string } | null;
  sections: FirstDraftSection[];
};
export type FirstDraftFile = {
  v: typeof FIRST_DRAFT_VERSION;
  placeholder_sha1s: string[];
  draft: FirstDraftContent;
};

export function isFirstSiteBuildPayload(payload: unknown): boolean {
  if (!isFastSinglePassPayload(payload)) return false;
  const p = payload as { stage?: unknown; refine_mode?: unknown };
  return p.stage === "build" && p.refine_mode !== true;
}

function clean(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

function sentenceCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function ideaLine(idea: unknown): string {
  const first = clean(idea, 400).split(/(?<=[.!?])\s/)[0] ?? "";
  const stripped = first
    .replace(/^(please\s+)?(can you\s+|could you\s+)?(build|make|create|design|set up|setup|launch)\s+(me\s+|us\s+)?(a\s+|an\s+|the\s+)?(simple\s+|new\s+)?(website|site|web\s*site|landing page|page|web\s*app|app)\s+(for|about|that|where|to)\s+/i, "")
    .replace(/^(a|an)\s+(website|site|landing page|page|web\s*app|app)\s+(for|about|that|where|to)\s+/i, "");
  return clean(sentenceCase(stripped.replace(/[.!?]+$/, "")), 160);
}

export function homePlanFromBrief(brief: unknown): { home: SitePlan["pages"][number]; action: SitePlan["primary_action"]; tone: string } | null {
  const plan = parseSitePlan((brief as { plan?: unknown } | null | undefined)?.plan);
  if (!plan) return null;
  const home = plan.pages.find((p) => p.path === "/") ?? plan.pages[0];
  return home ? { home, action: plan.primary_action, tone: plan.tone } : null;
}

export function buildFirstDraft(input: { name: unknown; idea: unknown; brief?: unknown }): FirstDraftContent | null {
  const name = clean(input.name, 60);
  const idea = ideaLine(input.idea);
  const plan = homePlanFromBrief(input.brief);
  if (plan) {
    const [hero, ...rest] = plan.home.sections;
    const headline = clean(hero?.headline, 120) || name;
    if (!headline) return null;
    return {
      name: name || clean(plan.home.title, 60),
      headline,
      subhead: idea && idea.toLowerCase() !== headline.toLowerCase() ? idea : "",
      action: plan.action.label ? { label: clean(plan.action.label, 40), steps: clean(plan.action.steps, 200) } : null,
      sections: rest
        .map((s) => ({ name: clean(s.name, 40), text: clean(s.headline, 120) }))
        .filter((s) => s.name && s.text)
        .slice(0, DRAFT_MAX_SECTIONS),
    };
  }
  if (!name && !idea) return null;
  return {
    name,
    headline: name || idea,
    subhead: name ? idea : "",
    action: null,
    sections: [],
  };
}

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

export function placeholderHomeSha1s(starters: ReadonlyArray<Readonly<Record<string, string>>> = safeStarterFiles()): string[] {
  const out = new Set<string>();
  for (const files of starters) {
    const home = files[DRAFT_HOME_PATH];
    if (typeof home !== "string" || typeof files[FIRST_DRAFT_SECTIONS_PATH] !== "string" || typeof files[FIRST_DRAFT_LAYOUT_PATH] !== "string") continue;
    out.add(sha1Hex(home));
  }
  return [...out];
}

function safeStarterFiles(): Array<Readonly<Record<string, string>>> {
  const out: Array<Readonly<Record<string, string>>> = [];
  for (const provider of [zaviStarterProvider, viteStarterProvider]) {
    try {
      out.push(provider.starterFiles().files);
    } catch {
    }
  }
  return out;
}

export function firstDraftFile(draft: FirstDraftContent, sha1s: string[] = placeholderHomeSha1s()): FirstDraftFile | null {
  if (sha1s.length === 0) return null;
  return { v: FIRST_DRAFT_VERSION, placeholder_sha1s: sha1s, draft };
}

export function firstDraftForRun(payload: unknown, siteName: string | null | undefined): FirstDraftFile | null {
  if (!isFirstSiteBuildPayload(payload)) return null;
  const p = payload as { idea?: unknown; company_name?: unknown; design_brief?: unknown };
  const draft = buildFirstDraft({ name: siteName?.trim() || p.company_name, idea: p.idea, brief: p.design_brief });
  return draft ? firstDraftFile(draft) : null;
}

const CLEAR = `{ rm -f '${FIRST_DRAFT_PATH}' && echo __draft=cleared; } || echo __draft=failed`;

export function writeFirstDraftCmd(file: FirstDraftFile | null): string {
  const shas = (file?.placeholder_sha1s ?? []).filter((s) => /^[0-9a-f]{40}$/.test(s));
  if (!file || shas.length === 0) return CLEAR;
  const b64 = Buffer.from(JSON.stringify(file), "utf8").toString("base64");
  const write = [
    `{ mkdir -p '${FIRST_DRAFT_DIR}'`,
    `printf '%s' '${b64}' | base64 -d > '${FIRST_DRAFT_PATH}.tmp'`,
    `mv -f '${FIRST_DRAFT_PATH}.tmp' '${FIRST_DRAFT_PATH}'`,
    `echo __draft=written; } || { rm -f '${FIRST_DRAFT_PATH}.tmp'; echo __draft=failed; }`,
  ].join(" && ");
  return [
    `__h=$( { sha1sum '${FIRST_DRAFT_HOME_ABS}' 2>/dev/null || shasum '${FIRST_DRAFT_HOME_ABS}' 2>/dev/null; } | cut -c1-40 );`,
    `case "$__h" in ${shas.join("|")}) ${write} ;;`,
    `*) rm -f '${FIRST_DRAFT_PATH}'; echo __draft=skipped ;; esac`,
  ].join(" ");
}

export const CLEAR_FIRST_DRAFT_CMD = writeFirstDraftCmd(null);

type ClearRow = PromiseLike<{ data: unknown; error: { message: string } | null }>;
export type ClearDraftDeps = {
  findSandbox: (tenant_id: string, repo_full_name: string) => ClearRow;
  exec: (sandbox_id: string, cmd: string, timeoutMs: number) => Promise<{ stdout: string }>;
};

async function realClearDeps(): Promise<ClearDraftDeps> {
  const [{ asTenantId, tenantClient }, { execCommand }] = await Promise.all([import("@/services/tenant-client"), import("@/services/sandbox/e2b-client")]);
  return {
    findSandbox: (tenant_id, repo) =>
      tenantClient(asTenantId(tenant_id)).from("tenant_sandbox").select("e2b_sandbox_id, preview_status").eq("repo_full_name", repo).maybeSingle(),
    exec: (id, cmd, t) => execCommand(id, cmd, t),
  };
}

export async function clearFirstDraftForSite(
  site: { tenant_id: string; repo_full_name: string },
  injected?: ClearDraftDeps,
): Promise<"cleared" | "not_running" | "failed"> {
  try {
    const deps = injected ?? (await realClearDeps());
    const { data: box, error: boxErr } = await deps.findSandbox(site.tenant_id, site.repo_full_name);
    const b = box as { e2b_sandbox_id?: unknown; preview_status?: unknown } | null;
    if (boxErr) return "failed";
    if (typeof b?.e2b_sandbox_id !== "string" || !b.e2b_sandbox_id || (b.preview_status !== "live" && b.preview_status !== "starting")) return "not_running";
    const r = await deps.exec(b.e2b_sandbox_id, CLEAR_FIRST_DRAFT_CMD, 15_000);
    return draftStepOf(r.stdout) === "cleared" ? "cleared" : "failed";
  } catch {
    return "failed";
  }
}

export type DraftStep = "written" | "skipped" | "cleared" | "failed";
export function draftStepOf(stdout: string): DraftStep | null {
  const m = /__draft=(written|skipped|cleared|failed)\b/.exec(stdout);
  return m ? (m[1] as DraftStep) : null;
}

export const FIRST_DRAFT_MESSAGE = "zavi:first-draft";
export const FIRST_DRAFT_HEARTBEAT_MS = 2000;
export const FIRST_DRAFT_SECTIONS_PATH = "src/components/sections/index.ts";
export const FIRST_DRAFT_LAYOUT_PATH = "src/components/ui/layout.tsx";

export const FIRST_DRAFT_MODULE_SOURCE = [
  `import { createElement as h, useEffect } from "react";`,
  `import { CTA, Contact, Hero } from "../components/sections";`,
  `import { Container, Section, SectionHeader } from "../components/ui/layout";`,
  `const d = __ZAVI_DRAFT__;`,
  `const tell = (shown) => { try { if (window.parent !== window) window.parent.postMessage({ type: ${JSON.stringify(FIRST_DRAFT_MESSAGE)}, shown }, "*"); } catch {} };`,
  `export default function Home() {`,
  `  useEffect(() => { tell(true); const t = setInterval(() => tell(true), ${FIRST_DRAFT_HEARTBEAT_MS}); return () => { clearInterval(t); tell(false); }; }, []);`,
  `  const start = d.action && d.action.steps ? "#start" : "#contact";`,
  `  return h("div", { "data-zavi": "home", "data-zavi-first-draft": "" },`,
  `    h(Hero, { variant: "centered", eyebrow: d.name && d.name !== d.headline ? d.name : undefined, title: d.headline, subtitle: d.subhead || undefined, actions: [{ label: d.action ? d.action.label : "Get in touch", href: start }] }),`,
  `    d.sections.map((s, i) => h(Section, { key: i, tone: i % 2 === 0 ? "muted" : "default" }, h(Container, null, h(SectionHeader, { eyebrow: s.name, title: s.text })))),`,
  `    d.action && d.action.steps ? h(CTA, { id: "start", title: d.action.label, subtitle: d.action.steps, actions: [{ label: "Get in touch", href: "#contact" }] }) : null,`,
  `    h(Contact, { tone: "muted" }));`,
  `}`,
  ``,
].join("\n");

export const FIRST_DRAFT_PLUGIN_IMPORTS = [
  `import * as zaviFs from "node:fs";`,
  `import { createHash as zaviCreateHash } from "node:crypto";`,
];

export function firstDraftPluginSource(): string {
  return [
    `const zaviDraft = (() => {`,
    `  const fs = zaviFs;`,
    `  const draftPath = ${JSON.stringify(FIRST_DRAFT_PATH)};`,
    `  const homePath = ${JSON.stringify(FIRST_DRAFT_HOME_ABS)};`,
    `  const moduleSource = ${JSON.stringify(FIRST_DRAFT_MODULE_SOURCE)};`,
    `  const read = () => { try { const f = JSON.parse(fs.readFileSync(draftPath, "utf8")); return f && f.v === ${FIRST_DRAFT_VERSION} && f.draft && Array.isArray(f.placeholder_sha1s) ? f : null; } catch { return null; } };`,
    `  const homeSha = () => { try { return zaviCreateHash("sha1").update(fs.readFileSync(homePath)).digest("hex"); } catch { return null; } };`,
    `  const clean = (id) => String(id || "").split("?")[0];`,
    `  const active = () => { const f = read(); const sha = f ? homeSha() : null; return f && sha && f.placeholder_sha1s.includes(sha) ? f : null; };`,
    `  return {`,
    `    name: "zavi-first-draft",`,
    `    apply: "serve",`,
    `    enforce: "pre",`,
    `    config: () => (active() ? { server: { hmr: { overlay: false } } } : undefined),`,
    `    load(id) {`,
    `      if (clean(id) !== homePath) return null;`,
    `      const f = active();`,
    `      return f ? moduleSource.replace("__ZAVI_DRAFT__", () => JSON.stringify(f.draft)) : null;`,
    `    },`,
    `    configureServer(server) {`,
    `      try {`,
    `        server.watcher.add(draftPath);`,
    `        const kick = (file) => {`,
    `          if (file !== draftPath) return;`,
    `          const mods = server.moduleGraph.getModulesByFile(homePath);`,
    `          if (mods) for (const m of mods) server.moduleGraph.invalidateModule(m);`,
    `          server.ws.send({ type: "full-reload" });`,
    `        };`,
    `        for (const ev of ["add", "change", "unlink"]) server.watcher.on(ev, kick);`,
    `      } catch {}`,
    `    },`,
    `  };`,
    `})();`,
  ].join("\n");
}
