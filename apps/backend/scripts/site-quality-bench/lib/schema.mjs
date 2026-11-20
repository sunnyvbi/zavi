import { sep, resolve } from "node:path";

export const SYSTEMS = ["zavi", "lovable", "other"];
export const PROVENANCES = ["actual_ai_build", "mocked", "hand_written_demo", "manual_import"];
export const EVIDENCE_PROVENANCES = ["actual_ai_build", "manual_import"];
export const SCORE_AXES = ["hierarchy", "typography", "spacing", "imagery", "consistency", "mobile_readability"];
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isEvidence(record) {
  return EVIDENCE_PROVENANCES.includes(record?.provenance);
}

export function isUnderMockDir(filePath) {
  if (!filePath) return false;
  const norm = resolve(String(filePath)).split(sep).join("/");
  return /(^|\/)fixtures\/mock(\/|$)/.test(norm);
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function nullableNonNegative(v) {
  return v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
}

export function validateScores(scores, where = "scores") {
  const errs = [];
  if (scores === null || scores === undefined) return errs;
  if (!isObj(scores)) return [`${where} must be an object or null`];
  let anyScored = false;
  for (const axis of SCORE_AXES) {
    const v = scores[axis];
    if (v === null || v === undefined) continue;
    if (!Number.isInteger(v) || v < 1 || v > 5) errs.push(`${where}.${axis} must be an integer 1-5 or null`);
    else anyScored = true;
  }
  for (const k of Object.keys(scores)) {
    if (k !== "rater" && !SCORE_AXES.includes(k)) errs.push(`${where}.${k} is not a known axis`);
  }
  if (anyScored && !nonEmptyString(scores.rater)) errs.push(`${where}.rater is required when any axis is scored`);
  return errs;
}

export function validateRecord(record, { filePath = null, briefIds = null } = {}) {
  const errs = [];
  if (!isObj(record)) return ["record is not an object"];
  const r = record;
  if (!nonEmptyString(r.run_id)) errs.push("run_id is required");
  if (!nonEmptyString(r.brief_id)) errs.push("brief_id is required");
  else if (briefIds && !briefIds.includes(r.brief_id)) errs.push(`brief_id "${r.brief_id}" is not a known brief`);
  if (!SYSTEMS.includes(r.system)) errs.push(`system must be one of ${SYSTEMS.join("|")}`);
  if (r.provenance === undefined || r.provenance === null || r.provenance === "") {
    errs.push("provenance is required");
  } else if (!PROVENANCES.includes(r.provenance)) {
    errs.push(`provenance must be one of ${PROVENANCES.join("|")}`);
  }
  if (r.provenance === "actual_ai_build") {
    if (isUnderMockDir(filePath)) errs.push("provenance actual_ai_build is not allowed for a file under fixtures/mock");
    const shotPaths = isObj(r.screenshots) ? [r.screenshots.desktop, r.screenshots.mobile] : [];
    if (shotPaths.some((p) => typeof p === "string" && /(^|\/)fixtures\/mock\//.test(p.split(sep).join("/")))) {
      errs.push("provenance actual_ai_build cannot point at screenshots under fixtures/mock");
    }
    if (r.system !== "zavi") errs.push("provenance actual_ai_build is only for zavi builds; competitor outputs are manual_import");
  }
  if (r.provenance === "manual_import" && r.system === "zavi") {
    errs.push("zavi records come from collect, not manual_import");
  }
  if (typeof r.captured_at !== "string" || !ISO_RE.test(r.captured_at)) errs.push("captured_at must be an ISO 8601 timestamp");
  if (r.urls !== undefined && r.urls !== null) {
    if (!isObj(r.urls)) errs.push("urls must be an object");
    else for (const [k, v] of Object.entries(r.urls)) if (v !== null && typeof v !== "string") errs.push(`urls.${k} must be a string or null`);
  }
  if (!isObj(r.screenshots)) errs.push("screenshots {desktop, mobile} is required");
  else for (const vp of Object.keys(VIEWPORTS)) {
    const v = r.screenshots[vp];
    if (v !== null && !nonEmptyString(v)) errs.push(`screenshots.${vp} must be a path or null`);
  }
  if (!isObj(r.timings)) errs.push("timings is required");
  else for (const k of ["to_first_preview_s", "to_usable_complete_s"]) {
    if (!nullableNonNegative(r.timings[k])) errs.push(`timings.${k} must be a non-negative number or null`);
  }
  if (!isObj(r.cost)) errs.push("cost {usd, source} is required");
  else {
    if (!nullableNonNegative(r.cost.usd)) errs.push("cost.usd must be a non-negative number or null");
    if (!nonEmptyString(r.cost.source)) errs.push("cost.source is required");
  }
  if (!(r.repairs === null || (Number.isInteger(r.repairs) && r.repairs >= 0))) errs.push("repairs must be a non-negative integer or null");
  if (!Array.isArray(r.failures) || r.failures.some((f) => typeof f !== "string")) errs.push("failures must be a string[]");
  if (!Array.isArray(r.journeys)) errs.push("journeys must be an array");
  else r.journeys.forEach((j, i) => {
    if (!isObj(j) || !nonEmptyString(j.name) || typeof j.passed !== "boolean") errs.push(`journeys[${i}] must be {name, passed:boolean}`);
  });
  if (!Array.isArray(r.requirement_coverage)) errs.push("requirement_coverage must be an array");
  else r.requirement_coverage.forEach((c, i) => {
    if (!isObj(c) || !nonEmptyString(c.requirement) || typeof c.met !== "boolean" || typeof c.evidence !== "string") {
      errs.push(`requirement_coverage[${i}] must be {requirement, met:boolean, evidence:string}`);
    }
  });
  errs.push(...validateScores(r.scores));
  return errs;
}

export function assertValidRecord(record, opts) {
  const errs = validateRecord(record, opts);
  if (errs.length) throw new Error(`invalid run record${opts?.filePath ? ` ${opts.filePath}` : ""}: ${errs.join("; ")}`);
  return record;
}
