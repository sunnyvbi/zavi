import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRecord } from "./schema.mjs";

export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BRIEFS_PATH = join(BENCH_DIR, "fixtures", "briefs.json");
export const MOCK_DIR = join(BENCH_DIR, "fixtures", "mock");
export const RECORD_SUFFIX = ".record.json";

export function loadBriefs(path = BRIEFS_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return raw.briefs;
}

export function findBrief(briefs, id) {
  const b = briefs.find((x) => x.id === id);
  if (!b) throw new Error(`unknown brief "${id}". Known: ${briefs.map((x) => x.id).join(", ")}`);
  return b;
}

function walk(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort()) walk(join(path, name), out);
  } else if (path.endsWith(RECORD_SUFFIX)) {
    out.push(path);
  }
  return out;
}

export function loadRecordEntries(paths, { briefIds = null } = {}) {
  const files = [];
  for (const p of paths) walk(resolve(p), files);
  const entries = [];
  const errors = [];
  for (const file of files) {
    let record;
    try {
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`${file}: not valid JSON (${e.message})`);
      continue;
    }
    const errs = validateRecord(record, { filePath: file, briefIds });
    if (errs.length) errors.push(`${file}: ${errs.join("; ")}`);
    else entries.push({ record, file });
  }
  return { entries, errors };
}

export function resolveShot(entry, viewport) {
  const p = entry.record.screenshots?.[viewport];
  if (!p) return null;
  return isAbsolute(p) ? p : resolve(dirname(entry.file), p);
}
