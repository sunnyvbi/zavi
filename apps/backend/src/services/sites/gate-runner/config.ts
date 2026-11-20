
export type GateStarter = "pooled" | "dedicated";

export type GateRole = "visitor" | "customer" | "owner";

export type GateStep =
  | { visit: string }
  | { click: string }
  | { expect: string }
  | { expectText: string }
  | { expectNoText: string }
  | { deniedRead: string }
  | { fill: string; value: string };

export type GateJourney = {
  name: string;
  path: string;
  expect?: string;
  steps?: GateStep[];
  writes?: boolean;
  as?: GateRole;
  needs?: string;
  dry_run?: boolean;
  booking?: boolean;
};

export type GateWrite = {
  collection: string;
  record: Record<string, unknown>;
  tag_field: string | null;
  protected_get: boolean;
  protected_list: boolean;
};

export type GateRunnerConfig = {
  version: 1;
  starter: GateStarter;
  routes: string[];
  journeys: GateJourney[];
  allow_writes: boolean;
  write: GateWrite | null;
  protected_lists: string[];
  tag: string;
  read_only: boolean;
  brand?: boolean;
  screenshots?: boolean;
  thumbnail?: boolean;
  preview_snapshot?: boolean;
  page_text?: boolean;
  scan_only?: boolean;
  scan_links?: boolean;
  images?: GateImagesCheck;
};

export type GateImagesCheck = { require_loaded: boolean; owned?: string[] };

export class ManifestError extends Error {
  constructor(msg: string) {
    super(`zavi-site.json: ${msg}`);
    this.name = "ManifestError";
  }
}

const SELECTOR = /^\[data-zavi(?:-[a-z0-9-]+)?=("?)[A-Za-z0-9_-]+\1\]$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const COLLECTION = /^[a-z][a-z0-9_]{0,62}$/;
const ROUTE = /^\/[A-Za-z0-9._~\-/]*$/;
const SMOKE_TOKEN = "{smoke}";
export const MAX_ROUTES = 20;
export const GATE_TAG_LENGTH = 27;
const MAX_JOURNEYS = 30;
const MAX_STEPS = 40;

function fail(msg: string): never {
  throw new ManifestError(msg);
}

function checkPath(where: string, path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || path.length > 200) {
    fail(`${where}: path must be a same-site path starting with "/" (got ${JSON.stringify(path)})`);
  }
  return path;
}

function checkSelector(where: string, sel: unknown): string {
  if (typeof sel !== "string" || !SELECTOR.test(sel)) {
    fail(`${where}: selector must be a data-zavi hook like [data-zavi=name] (got ${JSON.stringify(sel)})`);
  }
  return sel;
}

function checkText(where: string, text: unknown): string {
  if (typeof text !== "string" || text.length < 1 || text.length > 200) fail(`${where}: text must be 1-200 characters`);
  return text;
}

function checkStep(where: string, step: unknown, as: GateRole): GateStep {
  if (!step || typeof step !== "object" || Array.isArray(step)) fail(`${where}: step must be an object`);
  const s = step as Record<string, unknown>;
  const keys = Object.keys(s);
  if (keys.length === 1) {
    if ("visit" in s) return { visit: checkPath(where, s.visit) };
    if ("click" in s) return { click: checkSelector(where, s.click) };
    if ("expect" in s) return { expect: checkSelector(where, s.expect) };
    if ("expectText" in s) return { expectText: checkText(where, s.expectText) };
    if ("expectNoText" in s) return { expectNoText: checkText(where, s.expectNoText) };
    if ("deniedRead" in s) {
      if (as !== "visitor") fail(`${where}: deniedRead runs signed out, so it belongs in a visitor journey`);
      if (typeof s.deniedRead !== "string" || !COLLECTION.test(s.deniedRead)) fail(`${where}: deniedRead takes a collection name`);
      return { deniedRead: s.deniedRead };
    }
  }
  if ("fill" in s && keys.length === 2 && typeof s.value === "string" && s.value.length <= 500) {
    return { fill: checkSelector(where, s.fill), value: s.value };
  }
  return fail(`${where}: unknown step ${JSON.stringify(step).slice(0, 120)} (use visit, fill+value, click, expect, expectText, expectNoText or deniedRead)`);
}

export function parseJourneys(doc: Record<string, unknown>): GateJourney[] {
  const raw = (doc.smoke as { journeys?: unknown } | undefined)?.journeys;
  if (!Array.isArray(raw) || raw.length === 0) fail("smoke.journeys must be a non-empty array");
  if (raw.length > MAX_JOURNEYS) fail(`smoke.journeys has more than ${MAX_JOURNEYS} journeys`);
  const seen = new Map<string, GateRole>();
  const out: GateJourney[] = [];
  for (const j of raw as Array<Record<string, unknown> | null>) {
    if (!j || typeof j !== "object" || typeof j.name !== "string" || !NAME.test(j.name)) {
      fail(`journey name ${JSON.stringify(j?.name)} must be lowercase-kebab`);
    }
    const name = j.name;
    if (seen.has(name)) fail(`duplicate journey name "${name}"`);
    const path = checkPath(name, j.path);
    if (j.as !== undefined && j.as !== "visitor" && j.as !== "customer" && j.as !== "owner") {
      fail(`${name}: as must be "visitor", "customer" or "owner"`);
    }
    const as = (j.as ?? "visitor") as GateRole;
    if (j.needs !== undefined && (typeof j.needs !== "string" || !seen.has(j.needs))) fail(`${name}: needs must name an earlier journey`);
    if (j.needs !== undefined && as === "visitor" && seen.get(j.needs as string) !== "visitor") {
      const role = seen.get(j.needs as string);
      fail(`${name}: a visitor journey cannot need ${role === "owner" ? "an owner" : "a customer"} journey (signed-in journeys run after visitors)`);
    }
    seen.set(name, as);
    if (j.steps !== undefined && !Array.isArray(j.steps)) fail(`${name}: steps must be an array`);
    const stepsRaw = (j.steps ?? []) as unknown[];
    if (stepsRaw.length > MAX_STEPS) fail(`${name}: more than ${MAX_STEPS} steps`);
    const steps = stepsRaw.map((s, i) => checkStep(`${name} step ${i + 1}`, s, as));
    if (j.writes !== undefined && typeof j.writes !== "boolean") fail(`${name}: writes must be true or false`);
    if (j.writes && !steps.some((s) => "fill" in s && s.value.includes(SMOKE_TOKEN))) {
      fail(`${name}: a writes journey must put ${SMOKE_TOKEN} in at least one filled value`);
    }
    if (steps.some((s) => "deniedRead" in s)) {
      const dep = (raw as Array<Record<string, unknown>>).find((x) => x?.name === j.needs);
      if (!dep || dep.writes !== true) fail(`${name}: a deniedRead journey must "needs" the writes journey that creates the record`);
    }
    const journey: GateJourney = { name, path, as };
    if (j.expect !== undefined) journey.expect = checkSelector(name, j.expect);
    if (steps.length) journey.steps = steps;
    if (j.writes === true) journey.writes = true;
    if (j.needs !== undefined) journey.needs = j.needs as string;
    out.push(journey);
  }
  return out;
}

export function declaredRoutes(doc: Record<string, unknown>, journeys: GateJourney[]): string[] {
  const set = new Set<string>(["/"]);
  const add = (p: string) => {
    const path = p.split("#")[0];
    if (ROUTE.test(path.split("?")[0])) set.add(path);
  };
  for (const j of journeys) {
    add(j.path);
    for (const s of j.steps ?? []) if ("visit" in s) add(s.visit);
  }
  if (doc.routes !== undefined) {
    if (!Array.isArray(doc.routes)) fail("routes must be an array of paths");
    for (const r of doc.routes) add(checkPath("routes", r));
  }
  const routes = [...set];
  if (routes.length > MAX_ROUTES) fail(`more than ${MAX_ROUTES} distinct routes are declared`);
  return routes;
}

type PropSchema = {
  type?: unknown;
  enum?: unknown;
  format?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  minimum?: unknown;
  exclusiveMinimum?: unknown;
  minItems?: unknown;
};

const FORMAT_VALUES: Record<string, string> = {
  email: "smoke@example.com",
  "date-time": "2030-01-01T12:00:00Z",
  date: "2030-01-01",
  time: "12:00:00Z",
  uuid: "00000000-0000-4000-8000-000000000000",
  uri: "https://example.com/zavi-smoke",
  url: "https://example.com/zavi-smoke",
  hostname: "example.com",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function valueFor(prop: PropSchema, tagCandidate: boolean): { value: unknown; tagged: boolean } | null {
  if (Array.isArray(prop.enum)) return prop.enum.length ? { value: prop.enum[0], tagged: false } : null;
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (type === "string") {
    if (prop.format !== undefined) {
      const v = typeof prop.format === "string" ? FORMAT_VALUES[prop.format] : undefined;
      return v === undefined ? null : { value: v, tagged: false };
    }
    if ((prop as { pattern?: unknown }).pattern !== undefined) return null;
    const min = num(prop.minLength) ?? 0;
    const max = num(prop.maxLength) ?? 200;
    if (tagCandidate && min <= GATE_TAG_LENGTH && max >= GATE_TAG_LENGTH) return { value: SMOKE_TOKEN, tagged: true };
    const base = "zavi smoke";
    let v = base.slice(0, max);
    if (v.length < min) v = v.padEnd(min, "x");
    return v.length <= max ? { value: v, tagged: false } : null;
  }
  if (type === "number" || type === "integer") {
    const min = num(prop.minimum);
    const ex = num(prop.exclusiveMinimum);
    return { value: ex !== null ? ex + 1 : min ?? 0, tagged: false };
  }
  if (type === "boolean") return { value: false, tagged: false };
  if (type === "array") return (num(prop.minItems) ?? 0) > 0 ? null : { value: [], tagged: false };
  return null;
}

const allows = (rules: unknown, op: string): boolean =>
  Array.isArray((rules as Record<string, unknown> | undefined)?.[op]) &&
  ((rules as Record<string, unknown[]>)[op]).includes("anyone");

export type SynthResult = { record: Record<string, unknown>; tag_field: string | null } | { error: string };

export function synthesizeRecord(col: Record<string, unknown>): SynthResult {
  const schema = (col.schema ?? {}) as { type?: unknown; required?: unknown; properties?: unknown };
  if (schema.type !== undefined && schema.type !== "object") return { error: "its schema is not an object" };
  const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, PropSchema>;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  const fields = (col.fields ?? {}) as Record<string, { write?: unknown }>;
  const writable = (k: string) => !Array.isArray(fields[k]?.write) || (fields[k].write as unknown[]).includes("anyone");
  const record: Record<string, unknown> = {};
  let tag_field: string | null = null;
  for (const k of required) {
    if (!writable(k)) return { error: `required field "${k}" is not writable by a visitor` };
    if (!props[k]) return { error: `required field "${k}" has no schema` };
    const v = valueFor(props[k], tag_field === null);
    if (!v) return { error: `required field "${k}" uses a schema the publish check cannot fill (use a plain type, enum or a common format)` };
    record[k] = v.value;
    if (v.tagged) tag_field = k;
  }
  if (tag_field === null) {
    for (const [k, p] of Object.entries(props)) {
      if (k in record || !writable(k)) continue;
      const v = valueFor(p, true);
      if (v?.tagged) {
        record[k] = v.value;
        tag_field = k;
        break;
      }
    }
  }
  return { record, tag_field };
}

function collectionsOf(doc: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  const cols = doc.collections;
  if (!cols || typeof cols !== "object" || Array.isArray(cols)) return [];
  return Object.entries(cols as Record<string, Record<string, unknown>>).filter(
    ([name, c]) => COLLECTION.test(name) && !!c && typeof c === "object",
  );
}

export function protectedLists(doc: Record<string, unknown>): string[] {
  return collectionsOf(doc)
    .filter(([, c]) => !allows(c.rules, "list"))
    .map(([name]) => name)
    .slice(0, 5);
}

export function pickWriteCollection(doc: Record<string, unknown>): GateWrite | null {
  let best: GateWrite | null = null;
  const unfillable: string[] = [];
  for (const [name, c] of collectionsOf(doc)) {
    if (!allows(c.rules, "create")) continue;
    const rec = synthesizeRecord(c);
    if ("error" in rec) {
      unfillable.push(`${name}: ${rec.error}`);
      continue;
    }
    const w: GateWrite = {
      collection: name,
      record: rec.record,
      tag_field: rec.tag_field,
      protected_get: !allows(c.rules, "get"),
      protected_list: !allows(c.rules, "list"),
    };
    if (w.protected_get || w.protected_list) return w;
    best ??= w;
  }
  if (!best && unfillable.length) fail(`the publish check cannot create a test record in collections.${unfillable[0]}`);
  return best;
}

export function isPooledManifest(doc: Record<string, unknown>): boolean {
  const c = doc.collections;
  return !!c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length > 0;
}

export function buildRunnerConfig(input: {
  manifestRaw: string;
  allow_writes: boolean;
  backend_mode?: string | null;
  tag: string;
  brand?: boolean;
  images?: GateImagesCheck;
}): GateRunnerConfig {
  let doc: unknown;
  try {
    doc = JSON.parse(input.manifestRaw);
  } catch (e) {
    fail(`not valid JSON (${String((e as Error)?.message ?? e).slice(0, 120)})`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail("must be a JSON object");
  const d = doc as Record<string, unknown>;
  const journeys = parseJourneys(d);
  const starter: GateStarter = input.backend_mode === "pooled" || isPooledManifest(d) ? "pooled" : "dedicated";
  return {
    version: 1,
    starter,
    routes: declaredRoutes(d, journeys),
    journeys,
    allow_writes: input.allow_writes,
    write: starter === "pooled" && input.allow_writes ? pickWriteCollection(d) : null,
    protected_lists: starter === "pooled" ? protectedLists(d) : [],
    tag: input.tag,
    read_only: !input.allow_writes,
    ...(input.brand === true ? { brand: true } : {}),
    ...(input.images
      ? {
          images: {
            require_loaded: input.images.require_loaded === true,
            ...(input.images.owned?.length ? { owned: input.images.owned.filter((p) => ROUTE.test(p)).slice(0, 64) } : {}),
          },
        }
      : {}),
  };
}

export function buildScanConfig(input: { tag: string; routes?: string[]; screenshots?: boolean; thumbnail?: boolean; preview_snapshot?: boolean; links?: boolean }): GateRunnerConfig {
  const routes = ["/", ...(input.routes ?? []).filter((r) => ROUTE.test(r) && r !== "/")].slice(0, MAX_ROUTES);
  return {
    version: 1,
    starter: "dedicated",
    routes: [...new Set(routes)],
    journeys: [],
    allow_writes: false,
    write: null,
    protected_lists: [],
    tag: input.tag,
    read_only: true,
    scan_only: true,
    ...(input.screenshots === true ? { screenshots: true } : {}),
    ...(input.thumbnail === true ? { thumbnail: true } : {}),
    ...(input.preview_snapshot === true ? { preview_snapshot: true } : {}),
    ...(input.links === false ? { scan_links: false } : {}),
  };
}
