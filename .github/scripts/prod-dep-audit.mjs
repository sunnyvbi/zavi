#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const LOCKFILE = "package-lock.json";
const BULK_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const BATCH = 400;
const ATTEMPTS = 3;
const BLOCK_AT = "critical";

const WAIVERS = [];

function ghsaOf(adv) {
  const m = /\/(GHSA-[0-9a-z-]+)/i.exec(adv.url ?? "");
  return m ? m[1] : null;
}

function waiverFor(pkgName, adv) {
  const ghsa = ghsaOf(adv);
  if (!ghsa) return null;
  const today = new Date().toISOString().slice(0, 10);
  return WAIVERS.find(
    (w) => w.package === pkgName && w.id === ghsa && today < w.expires,
  );
}

function productionDeps() {
  const lock = JSON.parse(readFileSync(LOCKFILE, "utf8"));
  const packages = lock.packages;
  if (!packages) {
    throw new Error(
      `${LOCKFILE} has no "packages" map (lockfileVersion ${lock.lockfileVersion ?? "?"}). ` +
        `This gate needs lockfileVersion 2+.`,
    );
  }

  const byName = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    if (!path) continue;
    if (entry.link) continue;
    if (entry.dev || entry.peer || entry.optional) continue;
    if (!entry.version) continue;

    const marker = "node_modules/";
    const at = path.lastIndexOf(marker);
    if (at === -1) continue;
    const name = path.slice(at + marker.length);
    if (!name) continue;

    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(entry.version);
  }

  return Object.fromEntries([...byName].map(([n, vs]) => [n, [...vs]]));
}

async function fetchAdvisories(batch) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(BULK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const body = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
      return JSON.parse(body.toString("utf8"));
    } catch (err) {
      lastErr = err;
      if (attempt < ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastErr;
}

function chunk(entries, size) {
  const out = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}

async function main() {
  const deps = productionDeps();
  const entries = Object.entries(deps);
  if (entries.length === 0) {
    console.error("::error::no production dependencies resolved from the lockfile — the gate would pass vacuously, which is worse than failing. Check the lockfile.");
    process.exit(1);
  }

  const blocking = [];
  let waivedCount = 0;
  for (const part of chunk(entries, BATCH)) {
    let advisories;
    try {
      advisories = await fetchAdvisories(Object.fromEntries(part));
    } catch (err) {
      console.error(
        `::error::could not reach the npm bulk advisory endpoint after ${ATTEMPTS} attempts (${err.message}). ` +
          `Not treating an unreachable advisory service as a clean result.`,
      );
      process.exit(1);
    }

    for (const [name, list] of Object.entries(advisories ?? {})) {
      for (const adv of list ?? []) {
        if (adv.severity === BLOCK_AT) {
          const waived = waiverFor(name, adv);
          if (waived) {
            console.log(
              `::warning::WAIVED ${ghsaOf(adv)} on ${name} until ${waived.expires} — ${waived.why}`,
            );
            waivedCount += 1;
            continue;
          }
          blocking.push({
            name,
            severity: adv.severity,
            range: adv.vulnerable_versions,
            title: adv.title,
            url: adv.url ?? (adv.id ? `https://github.com/advisories/${adv.id}` : ""),
            installed: deps[name].join(", "),
          });
        }
      }
    }
  }

  const pkgCount = entries.length;
  if (blocking.length > 0) {
    console.error(
      `::error::${blocking.length} ${BLOCK_AT} advisory/advisories in shipped production dependencies:`,
    );
    for (const b of blocking) {
      console.error(`::error::  ${b.name}@${b.installed} — ${b.title} (affects ${b.range}) ${b.url}`);
    }
    process.exit(1);
  }

  console.log(
    `OK — no unwaived ${BLOCK_AT} advisories across ${pkgCount} shipped production dependencies` +
      (waivedCount > 0
        ? ` (${waivedCount} waived — see the warnings above and WAIVERS in this file).`
        : "."),
  );
}

main().catch((err) => {
  console.error(`::error::prod-dep-audit failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
