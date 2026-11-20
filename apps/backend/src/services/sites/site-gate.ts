
import { randomBytes } from "node:crypto";
import { SITE_MANIFEST_PATH, SITE_REPO_DIR, type SiteGatePageBlock, type SiteGatePageText, type SiteGateResult, type SiteKeptJourneys, type SiteSandbox } from "./contract";
import { buildRunnerConfig, buildScanConfig, ManifestError, type GateImagesCheck, type GateRunnerConfig } from "./gate-runner/config";
import { GATE_RUNNER_SOURCE } from "./gate-runner/runner-source.generated";
import { SITE_IMAGE_MARKER } from "@/services/site-images/constants";import { BOOKING_JOURNEY_RE, briefMentionsBooking, manifestMentionsBooking } from "./booking-signal";
import {
  createE2bGateRunner,
  GATE_CONFIG_PATH,
  GATE_RUNNER_PATH,
  type GateRunnerExec,
} from "./gate-runner/sandbox-runner";
import { isTransientPlatformError } from "./platform-errors";
import {
  runVisionReview,
  visionModeOf,
  previewVisionEnabled,
  visionReviewEnabled,
  type SiteScreenshot,
  type SiteVisionBrief,
  type SiteVisionMode,
  type SiteVisionResult,
  type SiteVisionReview,
} from "./site-vision-review";

export const SITE_GATE_TIMEOUT_MS = 5 * 60_000;
const EVIDENCE_MAX = 2_000;
const REASON_MAX = 400;
const SHA = /^[0-9a-f]{7,40}$/;
const BRAND_JOURNEY = "zavi:brand";
export const ERROR_TEXT_JOURNEY = "zavi:error-text";
const IMAGES_JOURNEY = "zavi:images";
export class SiteGateInfrastructureError extends Error {
  constructor(message: string, readonly created: ReadonlyArray<{ collection: string; id: string }> = []) { super(message); this.name = "SiteGateInfrastructureError"; }
}
export const BOOKING_JOURNEY_MISSING =
  'this site takes bookings but has no booking check, so it cannot go live yet. Ask in the chat to "add a smoke journey named book that makes a test booking", then publish again.\n' +
  'zavi-site.json: smoke.journeys needs a journey named "book" with "writes": true and "as": "customer" that picks an open time and books it (put {smoke} in the name it fills).';
export const BOOKING_JOURNEY_NO_SUBMIT =
  'this site takes bookings but its booking check never submits the form, so it cannot go live yet. Ask in the chat to "make the book smoke journey click the booking button", then publish again.';
export const BOOKING_JOURNEY_FAILED =
  "a test booking on the site did not go through, so it cannot go live yet. Ask in the chat to fix booking, then publish again.";

export type SiteGateInput = {
  sandbox: SiteSandbox;
  preview_url: string;
  owner_link: string | null;
  customer_link?: string | null;
  customer_expected?: boolean;
  allow_writes: boolean;
  sha?: string;
  tenant_id?: string;
  site_id?: string;
  backend_mode?: string | null;
  brief?: string;
  booking_required?: boolean;
  brand_checks?: boolean;
  images_check?: boolean;
  first_build?: boolean;
  kept_journeys?: SiteKeptJourneys;
  site_name?: string | null;
  page_text?: boolean;
  vision?: { mode: SiteVisionMode; brief?: SiteVisionBrief | null };
  thumbnail?: boolean;
};

export const JOURNEY_DROPPED =
  "a fix pass removed or renamed smoke journey(s) the failed check had. Put them back in zavi-site.json unchanged and fix the site itself";
export const JOURNEY_CHANGED =
  "a fix pass changed smoke journey(s) that failed the check. Put them back in zavi-site.json unchanged and fix the site itself";

export function journeyFingerprint(j: { path?: unknown; expect?: unknown; steps?: unknown; as?: unknown; writes?: unknown; needs?: unknown }): string {
  return JSON.stringify([j.path ?? null, j.expect ?? null, j.steps ?? [], j.as ?? "visitor", j.writes === true, j.needs ?? null]);
}

export function newGateTag(): string {
  return `zavi-smoke-${randomBytes(8).toString("hex")}`;
}

export type SiteGateDeps = {
  runner?: GateRunnerExec;
  visionReview?: SiteVisionReview;
  visionTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  visionMode?: (tenant_id: string) => Promise<string>;
};

async function previewVisionMode(tenant_id: string, read?: (tenant_id: string) => Promise<string>): Promise<SiteVisionMode> {
  try {
    if (read) return visionModeOf(await read(tenant_id));
    const { getStringSetting } = await import("@/services/settings");
    return visionModeOf(await getStringSetting("site_vision_review_mode", tenant_id));
  } catch {
    return "observe";
  }
}

export const CUSTOMER_JOURNEY = "zavi:customer";

export function requiredJourneys(config: GateRunnerConfig, hasOwnerLink: boolean, hasCustomerLink = false): string[] {
  const out = ["zavi:home", "zavi:routes", "zavi:mobile", ERROR_TEXT_JOURNEY];
  if (config.brand) out.push(BRAND_JOURNEY);
  if (config.images) out.push(IMAGES_JOURNEY);
  if (hasCustomerLink && config.journeys.some((j) => j.as === "customer")) out.push(CUSTOMER_JOURNEY);
  if (config.starter !== "pooled") return out;
  if (config.protected_lists.length) out.push("zavi:read-denied");
  const w = config.allow_writes ? config.write : null;
  if (w) {
    out.push("zavi:write-create");
    if (w.protected_get || w.protected_list) out.push("zavi:write-denied");
    if (hasOwnerLink || !w.protected_get) out.push("zavi:write-readback");
  }
  return out;
}

export function gateSecrets(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    out.add(v);
    try {
      const u = new URL(v);
      for (const p of u.searchParams.values()) if (p.length >= 8) out.add(p);
      const frag = u.hash.replace(/^#/, "");
      if (frag.length >= 8) {
        out.add(frag);
        for (const p of new URLSearchParams(frag).values()) if (p.length >= 8) out.add(p);
      }
    } catch {
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function scrub(text: string, secrets: readonly string[]): string {
  let out = String(text ?? "");
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

type SmokeJourney = { name?: unknown; ok?: unknown; skipped?: unknown; reason?: unknown };
type SmokeOutput = { ok?: unknown; journeys?: unknown; owner?: unknown; error?: unknown; infrastructure_error?: unknown; screenshots?: unknown; og_title?: unknown };

function parseSmoke(stdout: string): SmokeOutput | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const v = JSON.parse(lines[i]) as unknown;
      if (v && typeof v === "object") return v as SmokeOutput;
    } catch {
    }
  }
  return null;
}

export const OWNER_CASCADE_REASON = "the owner could not sign in";

export function failureReason(out: SmokeOutput, bookingJourney: string | null): string {
  if (typeof out.error === "string" && out.error) return out.error;
  const journeys = Array.isArray(out.journeys) ? (out.journeys as SmokeJourney[]) : [];
  const owner = out.owner as SmokeJourney | null | undefined;
  const ownerFailed = !!owner && typeof owner === "object" && owner.ok === false;
  const ownerSaid = ownerFailed ? `the owner sign-in failed: ${String(owner.reason ?? "no reason")}` : "";
  const failed = journeys.find((j) => j && j.ok === false && !(ownerFailed && String(j.reason ?? "") === OWNER_CASCADE_REASON));
  if (failed) {
    const name = String(failed.name ?? "?");
    const why = String(failed.reason ?? "no reason");
    const also = ownerFailed ? `\nAlso, ${ownerSaid}` : "";
    if (name === BRAND_JOURNEY || name === ERROR_TEXT_JOURNEY || name === IMAGES_JOURNEY) return why + also;
    const said = `journey "${name}" failed: ${why}`;
    return (name === bookingJourney ? `${BOOKING_JOURNEY_FAILED}\n${said}` : said) + also;
  }
  if (ownerFailed) return ownerSaid;
  return "the smoke check failed";
}

async function readManifest(input: SiteGateInput): Promise<string> {
  if (input.sha !== undefined) {
    if (!SHA.test(input.sha)) throw new Error("invalid commit sha");
    const r = await input.sandbox.run(`git --no-replace-objects show ${input.sha}:${SITE_MANIFEST_PATH}`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
    if (r.transportError || r.timedOut) throw new SiteGateInfrastructureError("the site's workspace did not answer while reading zavi-site.json");
    if (r.exitCode !== 0) throw new ManifestError(`not found at commit ${input.sha.slice(0, 12)}`);
    return r.stdout;
  }
  const raw = await input.sandbox.readFile(`${SITE_REPO_DIR}/${SITE_MANIFEST_PATH}`);
  return typeof raw === "string" ? raw : raw.toString("utf-8");
}

export function markerImagePaths(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as { images?: unknown };
    if (!Array.isArray(v?.images)) return [];
    const out = new Set<string>();
    for (const e of v.images as Array<{ src?: unknown; srcset?: unknown }>) {
      if (!e || typeof e !== "object") continue;
      if (typeof e.src === "string" && e.src.startsWith("/")) out.add(e.src);
      if (typeof e.srcset === "string") {
        for (const part of e.srcset.split(",")) {
          const path = part.trim().split(/\s+/)[0] ?? "";
          if (path.startsWith("/")) out.add(path);
        }
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

async function imagesCheckFor(input: SiteGateInput): Promise<GateImagesCheck | "never_tried" | undefined> {
  let owned: string[] = [];
  let hasMarker = false;
  let readable = false;
  try {
    const r = input.sha !== undefined && SHA.test(input.sha)
      ? await input.sandbox.run(`git --no-replace-objects show ${input.sha}:${SITE_IMAGE_MARKER}`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 })
      : null;
    if (r) readable = true;
    if (r && r.exitCode === 0) {
      hasMarker = true;
      owned = markerImagePaths(r.stdout);
    }
  } catch {
    owned = [];
  }
  if (input.first_build === true && readable && !hasMarker && input.brief && !briefAsksNoImages(input.brief)) return "never_tried";
  if (owned.length === 0 && input.first_build !== true) return undefined;
  if (input.first_build !== true) return { require_loaded: false, owned };
  return owned.length ? { require_loaded: true, owned } : { require_loaded: false };
}

const NO_IMAGES_RE = /\b(?:no|without|zero|skip(?:ping)?|don'?t (?:use|want|add|need)|do not (?:use|want|add|need))\s+(?:any\s+)?(?:images?|photos?|photographs?|pictures?|imagery|stock photos?)\b(?!\s+(?:of|from|with|for|showing|that|which|by|on)\b)/i;

export function briefAsksNoImages(brief: string): boolean {
  return NO_IMAGES_RE.test(brief);
}

export const SITE_IMAGES_NEVER_TRIED =
  "the site has no photos: the builder never called add_site_images. Call it once with a hero and the key sections' photos, then put them on the pages (src, srcset, width, height, alt). If it reports that no photo could be made, keep the design without photos.";

function fail(reason: string, secrets: string[], owner_link: string | null, evidence = ""): SiteGateResult {
  return {
    ok: false,
    reason: scrub(reason, secrets).slice(0, REASON_MAX),
    evidence: scrub(evidence, secrets).slice(-EVIDENCE_MAX),
    owner_journey: owner_link ? "failed" : "not_required",
  };
}

export async function runSiteGate(input: SiteGateInput, deps: SiteGateDeps = {}): Promise<SiteGateResult> {
  const customerLink = input.customer_link ?? null;
  const secrets = gateSecrets([input.owner_link, customerLink, input.preview_url]);
  const visionEnv = visionReviewEnabled(deps.env ?? process.env);
  const vision = visionEnv && input.vision?.mode !== "off";

  let config: GateRunnerConfig;
  let bookingJourney: string | null = null;
  let fingerprints: Record<string, string> = {};
  try {
    const manifestRaw = await readManifest(input);
    const imagesCheck = input.images_check === true ? await imagesCheckFor(input) : undefined;
    if (imagesCheck === "never_tried") return fail(SITE_IMAGES_NEVER_TRIED, secrets, input.owner_link);
    config = buildRunnerConfig({
      manifestRaw,
      allow_writes: input.allow_writes,
      backend_mode: input.backend_mode ?? null,
      tag: newGateTag(),
      brand: input.brand_checks === true,
      images: imagesCheck,
    });
    if (vision) config.screenshots = true;
    else if (input.thumbnail === true) config.thumbnail = true;
    if (input.page_text === true) config.page_text = true;
    fingerprints = Object.fromEntries(config.journeys.map((j) => [j.name, journeyFingerprint(j)]));
    if (input.booking_required === true && (briefMentionsBooking(input.brief) || manifestMentionsBooking(JSON.parse(manifestRaw)))) {
      const booking = config.journeys.find((j) => j.writes === true && BOOKING_JOURNEY_RE.test(j.name));
      if (!booking) return fail(BOOKING_JOURNEY_MISSING, secrets, input.owner_link);
      if (!(booking.steps ?? []).some((st) => "click" in st)) return fail(BOOKING_JOURNEY_NO_SUBMIT, secrets, input.owner_link);
      bookingJourney = booking.name;
      booking.booking = true;
      if (booking.as === "owner" && config.allow_writes) booking.as = "customer";
      if (!config.allow_writes) {
        booking.dry_run = true;
        if (booking.as !== "visitor") booking.as = "visitor";
      }
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (e instanceof SiteGateInfrastructureError) throw e;
    if (!(e instanceof ManifestError) && isTransientPlatformError(e)) {
      throw new SiteGateInfrastructureError(scrub(`the smoke check could not read zavi-site.json: ${msg}`, secrets).slice(0, REASON_MAX));
    }
    const reason = e instanceof ManifestError ? msg : `the smoke check could not read zavi-site.json: ${msg}`;
    return fail(reason, secrets, input.owner_link);
  }
  const kept = input.kept_journeys;
  const declared = new Set(config.journeys.map((j) => j.name));
  const dropped = (kept?.names ?? []).filter((n) => !declared.has(n));
  if (dropped.length) return fail(`${JOURNEY_DROPPED}: ${dropped.join(", ")}`, secrets, input.owner_link);
  const changed = Object.entries(kept?.fingerprints ?? {})
    .filter(([name, print]) => declared.has(name) && fingerprints[name] !== print)
    .map(([name]) => name);
  if (changed.length) return fail(`${JOURNEY_CHANGED}: ${changed.join(", ")}`, secrets, input.owner_link);

  if (config.allow_writes && input.customer_expected === true && !customerLink && config.journeys.some((j) => j.as === "customer")) {
    throw new SiteGateInfrastructureError("the test site has no customer sign-in, so its customer journeys cannot run");
  }

  const env: Record<string, string> = { GATE_BASE_URL: input.preview_url };
  if (input.owner_link) env.GATE_OWNER_LINK = input.owner_link;
  if (customerLink) env.GATE_CUSTOMER_LINK = customerLink;
  const runner = deps.runner ?? createE2bGateRunner();

  let res: { exitCode: number; stdout: string; stderr: string };
  try {
    res = await runner({
      tenant_id: input.tenant_id ?? "unknown",
      site_id: input.site_id ?? "unknown",
      files: { [GATE_RUNNER_PATH]: GATE_RUNNER_SOURCE, [GATE_CONFIG_PATH]: JSON.stringify(config) },
      command: `node ${GATE_RUNNER_PATH} ${GATE_CONFIG_PATH}`,
      env,
      redact: secrets,
      timeoutMs: SITE_GATE_TIMEOUT_MS,
    });
  } catch (e) {
    throw new SiteGateInfrastructureError(scrub(`the smoke check could not run: ${String((e as Error)?.message ?? e)}`, secrets).slice(0, REASON_MAX));
  }

  const stdout = scrub(res.stdout ?? "", secrets);
  const stderr = scrub(res.stderr ?? "", secrets);
  const out = parseSmoke(stdout);
  const screenshots = takeScreenshots(out);
  const pageText = takePageText(out);
  if (out) delete (out as { page_text?: unknown }).page_text;
  const evidence = (out ? JSON.stringify(out) : `${stdout}\n${stderr}`.trim()).slice(-EVIDENCE_MAX);
  if (!out || typeof out.ok !== "boolean" || !Array.isArray(out.journeys) || out.infrastructure_error === true) {
    const reason = out && typeof out.error === "string"
      ? out.error
      : `the smoke check exited ${res.exitCode} without a result${stderr ? `: ${stderr}` : ""}`;
    const said = scrub(reason, secrets).slice(0, REASON_MAX);
    console.warn(`[site-gate] event=infrastructure tenant=${input.tenant_id ?? "unknown"} site=${input.site_id ?? "unknown"} reason=${JSON.stringify(said.slice(0, 200))}`);
    const created = Array.isArray((out as { created?: unknown } | null)?.created)
      ? ((out as { created: unknown[] }).created.filter(
          (c): c is { collection: string; id: string } =>
            !!c && typeof (c as { collection?: unknown }).collection === "string" && typeof (c as { id?: unknown }).id === "string",
        ))
      : [];
    throw new SiteGateInfrastructureError(said, created);
  }
  let visionResult: SiteVisionResult | null = null;
  if (vision) {
    const og = typeof out.og_title === "string" ? out.og_title.trim() : "";
    visionResult = await runVisionReview(
      {
        tenant_id: input.tenant_id ?? "unknown",
        site_id: input.site_id ?? "unknown",
        expected_name: input.site_name?.trim() || og || null,
        screenshots,
        brief: input.vision?.brief ?? null,
      },
      deps.visionReview,
      deps.visionTimeoutMs,
    ).catch((): SiteVisionResult => ({ status: "not_reviewed", reason: "error", findings: [] }));
  }
  const visionOut: Pick<SiteGateResult, "vision"> = visionResult
    ? { vision: { status: visionResult.status, ...(visionResult.status === "reviewed" ? { ok: visionResult.ok } : { reason: visionResult.reason }), findings: visionResult.findings } }
    : visionEnv && input.vision?.mode === "off"
      ? { vision: { status: "not_reviewed", reason: "disabled", findings: [] } }
      : {};
  const owner = (out?.owner ?? null) as SmokeJourney | null;
  const owner_journey: SiteGateResult["owner_journey"] = !input.owner_link
    ? "not_required"
    : owner && typeof owner === "object" && owner.ok === true
      ? "passed"
      : "failed";
  const journeys = out && Array.isArray(out.journeys) ? (out.journeys as SmokeJourney[]) : [];
  const ran = new Set(journeys.filter((j) => j && j.ok === true && j.skipped !== true).map((j) => String(j.name ?? "")));
  const required = requiredJourneys(config, input.owner_link !== null, customerLink !== null);
  if (bookingJourney) required.push(bookingJourney);
  for (const j of config.journeys) {
    if (kept?.must_pass.includes(j.name) && (config.allow_writes || !j.writes) && !required.includes(j.name)) required.push(j.name);
  }
  const missing = required.filter((n) => !ran.has(n));
  const missingSaid = `the smoke result is missing or skipped the platform journey(s): ${missing.join(", ")}`;
  const allOk = journeys.every((j) => j && j.ok === true);
  const ok =
    res.exitCode === 0 && out !== null && out.ok === true && allOk && missing.length === 0 && owner_journey !== "failed";
  const text = pageText.length ? { page_text: pageText } : {};
  if (ok) {
    const home = input.thumbnail === true ? homeScreenshot(screenshots) : null;
    return { ok: true, reason: "smoke journeys passed", evidence: scrub(evidence, secrets), owner_journey, journeys: [...declared], all_fingerprints: fingerprints, ...text, ...visionOut, ...(home ? { thumbnail: home } : {}) };
  }
  const reason = out
    ? out.ok === true && allOk && missing.length > 0 && typeof out.error !== "string"
      ? bookingJourney && missing.includes(bookingJourney)
        ? `${BOOKING_JOURNEY_FAILED}\n${missingSaid}`
        : missingSaid
      : out.ok === true && allOk && owner_journey === "failed"
        ? "the owner sign-in journey did not run: the smoke result has no passing owner check"
        : failureReason(out, bookingJourney)
    : `the smoke check exited ${res.exitCode} without a result${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`;
  const errorTextFailed = journeys.some((j) => j && j.ok === false && j.name === ERROR_TEXT_JOURNEY);
  const onlyErrorText =
    errorTextFailed &&
    typeof out.error !== "string" &&
    owner_journey !== "failed" &&
    journeys.every((j) => j && (j.ok === true || j.name === ERROR_TEXT_JOURNEY)) &&
    missing.every((n) => n === ERROR_TEXT_JOURNEY);
  const failedNames = journeys
    .filter((j) => j && j.ok === false)
    .map((j) => String(j.name ?? ""))
    .filter((n) => declared.has(n));
  return {
    ok: false,
    reason: scrub(reason, secrets).slice(0, REASON_MAX),
    evidence: scrub(evidence, secrets),
    owner_journey,
    journeys: [...declared],
    failed_journeys: failedNames,
    fingerprints: Object.fromEntries(failedNames.map((n) => [n, fingerprints[n]!])),
    ...(errorTextFailed ? { error_text: onlyErrorText ? ("only" as const) : ("with_others" as const) } : {}),
    ...text,
    ...visionOut,
  };
}

export const PREVIEW_SCAN_TIMEOUT_MS = 3 * 60_000;

export type PreviewScanInput = {
  preview_url: string;
  tenant_id: string;
  site_id: string;
  site_name?: string | null;
  routes?: string[];
};

export type PreviewScanResult =
  | { kind: "clean"; routes: string[] }
  | { kind: "errors"; reason: string; routes: string[] }
  | { kind: "unscannable"; reason: string };

export async function runPreviewScan(input: PreviewScanInput, deps: SiteGateDeps = {}): Promise<PreviewScanResult> {
  const secrets = gateSecrets([input.preview_url]);
  const vision = previewVisionEnabled(deps.env ?? process.env) && (await previewVisionMode(input.tenant_id, deps.visionMode)) !== "off";
  const config = buildScanConfig({ tag: newGateTag(), routes: input.routes, screenshots: vision });
  const runner = deps.runner ?? createE2bGateRunner();
  let res: { exitCode: number; stdout: string; stderr: string };
  try {
    res = await runner({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      files: { [GATE_RUNNER_PATH]: GATE_RUNNER_SOURCE, [GATE_CONFIG_PATH]: JSON.stringify(config) },
      command: `node ${GATE_RUNNER_PATH} ${GATE_CONFIG_PATH}`,
      env: { GATE_BASE_URL: input.preview_url },
      redact: secrets,
      timeoutMs: PREVIEW_SCAN_TIMEOUT_MS,
    });
  } catch (e) {
    return { kind: "unscannable", reason: scrub(`the scan could not run: ${String((e as Error)?.message ?? e)}`, secrets).slice(0, REASON_MAX) };
  }
  const stdout = scrub(res.stdout ?? "", secrets);
  const out = parseSmoke(stdout);
  const screenshots = takeScreenshots(out);
  if (!out || typeof out.ok !== "boolean" || !Array.isArray(out.journeys) || out.infrastructure_error === true) {
    const said = out && typeof out.error === "string" ? out.error : `the scan exited ${res.exitCode} without a result`;
    return { kind: "unscannable", reason: scrub(said, secrets).slice(0, REASON_MAX) };
  }
  const journeys = out.journeys as SmokeJourney[];
  const routes = Array.isArray((out as { scanned_routes?: unknown }).scanned_routes)
    ? ((out as { scanned_routes: unknown[] }).scanned_routes.filter((r): r is string => typeof r === "string"))
    : [];
  if (vision) {
    const og = typeof out.og_title === "string" ? out.og_title.trim() : "";
    await runVisionReview(
      { tenant_id: input.tenant_id, site_id: input.site_id, expected_name: input.site_name?.trim() || og || null, screenshots },
      deps.visionReview,
      deps.visionTimeoutMs,
    ).catch(() => null);
  }
  const errorText = journeys.find((j) => j && j.name === ERROR_TEXT_JOURNEY);
  if (errorText && errorText.ok === false) {
    return { kind: "errors", reason: scrub(String(errorText.reason ?? "visible error text"), secrets).slice(0, REASON_MAX), routes };
  }
  const failed = journeys.find((j) => j && j.ok === false);
  if (failed || !errorText) {
    return { kind: "unscannable", reason: scrub(failed ? `${String(failed.name ?? "?")}: ${String(failed.reason ?? "failed")}` : "the scan returned no error-text result", secrets).slice(0, REASON_MAX) };
  }
  return { kind: "clean", routes };
}

export const THUMBNAIL_SCAN_TIMEOUT_MS = 2 * 60_000;

export async function captureHomeScreenshot(
  input: { preview_url: string; tenant_id: string; site_id: string },
  deps: Pick<SiteGateDeps, "runner"> = {},
): Promise<string | null> {
  const secrets = gateSecrets([input.preview_url]);
  const config = buildScanConfig({ tag: newGateTag(), routes: [], thumbnail: true, links: false });
  const runner = deps.runner ?? createE2bGateRunner();
  let res: { exitCode: number; stdout: string; stderr: string };
  try {
    res = await runner({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      files: { [GATE_RUNNER_PATH]: GATE_RUNNER_SOURCE, [GATE_CONFIG_PATH]: JSON.stringify(config) },
      command: `node ${GATE_RUNNER_PATH} ${GATE_CONFIG_PATH}`,
      env: { GATE_BASE_URL: input.preview_url },
      redact: secrets,
      timeoutMs: THUMBNAIL_SCAN_TIMEOUT_MS,
    });
  } catch (e) {
    throw new SiteGateInfrastructureError(scrub(`the thumbnail scan could not run: ${String((e as Error)?.message ?? e)}`, secrets).slice(0, REASON_MAX));
  }
  const out = parseSmoke(scrub(res.stdout ?? "", secrets));
  const shots = takeScreenshots(out);
  if (!out || !Array.isArray(out.journeys) || out.infrastructure_error === true) {
    const said = out && typeof out.error === "string" ? out.error : `the thumbnail scan exited ${res.exitCode} without a result`;
    throw new SiteGateInfrastructureError(scrub(said, secrets).slice(0, REASON_MAX));
  }
  if (out.ok !== true) return null;
  if (!(out.journeys as SmokeJourney[]).every((j) => j && j.ok === true)) return null;
  return homeScreenshot(shots);
}

export async function capturePreviewSnapshots(
  input: { preview_url: string; tenant_id: string; site_id: string },
  deps: Pick<SiteGateDeps, "runner"> = {},
): Promise<{ desktop: string; mobile: string | null } | null> {
  const secrets = gateSecrets([input.preview_url]);
  const config = buildScanConfig({ tag: newGateTag(), routes: [], preview_snapshot: true, links: false });
  const runner = deps.runner ?? createE2bGateRunner();
  let res: { exitCode: number; stdout: string; stderr: string };
  try {
    res = await runner({
      tenant_id: input.tenant_id,
      site_id: input.site_id,
      files: { [GATE_RUNNER_PATH]: GATE_RUNNER_SOURCE, [GATE_CONFIG_PATH]: JSON.stringify(config) },
      command: `node ${GATE_RUNNER_PATH} ${GATE_CONFIG_PATH}`,
      env: { GATE_BASE_URL: input.preview_url },
      redact: secrets,
      timeoutMs: THUMBNAIL_SCAN_TIMEOUT_MS,
    });
  } catch (e) {
    throw new SiteGateInfrastructureError(scrub(`the preview snapshot could not run: ${String((e as Error)?.message ?? e)}`, secrets).slice(0, REASON_MAX));
  }
  const out = parseSmoke(scrub(res.stdout ?? "", secrets));
  const shots = takeScreenshots(out);
  if (!out || !Array.isArray(out.journeys) || out.infrastructure_error === true) {
    const said = out && typeof out.error === "string" ? out.error : `the preview snapshot exited ${res.exitCode} without a result`;
    throw new SiteGateInfrastructureError(scrub(said, secrets).slice(0, REASON_MAX));
  }
  const scan = (out.journeys as SmokeJourney[]).filter((j) => !j || j.name !== "zavi:mobile_snapshot");
  if (!scan.length || !scan.every((j) => j && j.ok === true)) return null;
  const desktop = homeScreenshot(shots);
  if (!desktop) return null;
  return { desktop, mobile: shots.find((x) => x.label === "mobile" && x.path === "/")?.data ?? null };
}

const PAGE_TEXT_PAGES = 6;
const PAGE_TEXT_MAX = 6000;
const PAGE_BLOCKS_MAX = 30;
const BLOCK_HEAD_MAX = 160;

function takePageText(out: SmokeOutput | null): SiteGatePageText[] {
  const raw = (out as { page_text?: unknown } | null)?.page_text;
  if (!Array.isArray(raw)) return [];
  const pages: SiteGatePageText[] = [];
  for (const item of raw) {
    const p = item as { path?: unknown; text?: unknown; sections?: unknown; blocks?: unknown } | null;
    if (!p || typeof p.path !== "string" || typeof p.text !== "string" || !p.path.startsWith("/")) continue;
    const sections = Array.isArray(p.sections) ? p.sections.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 40)).slice(0, 40) : [];
    const blocks = Array.isArray(p.blocks)
      ? p.blocks
          .filter((b): b is SiteGatePageBlock => !!b && typeof (b as SiteGatePageBlock).head === "string" && Number.isFinite((b as SiteGatePageBlock).len))
          .slice(0, PAGE_BLOCKS_MAX)
          .map((b) => ({
            len: Math.max(0, Math.floor(b.len)),
            head: b.head.slice(0, BLOCK_HEAD_MAX),
            ...(typeof b.mark === "string" && b.mark ? { mark: b.mark.slice(0, 40) } : {}),
          }))
      : [];
    pages.push({ path: p.path.slice(0, 200), text: p.text.slice(0, PAGE_TEXT_MAX), sections, blocks });
    if (pages.length >= PAGE_TEXT_PAGES) break;
  }
  return pages;
}

function homeScreenshot(shots: SiteScreenshot[]): string | null {
  return shots.find((s) => s.label === "desktop" && s.path === "/")?.data ?? null;
}

function takeScreenshots(out: SmokeOutput | null): SiteScreenshot[] {
  if (!out || !("screenshots" in out)) return [];
  const raw = out.screenshots;
  delete out.screenshots;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is SiteScreenshot =>
        !!s && typeof s.label === "string" && typeof s.path === "string" && typeof s.data === "string" && s.data.length > 0,
    )
    .slice(0, 3);
}
