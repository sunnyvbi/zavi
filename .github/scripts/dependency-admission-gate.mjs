
import { readFileSync } from "node:fs";

const FILE = "apps/backend/src/services/mcp/internal/github.ts";

const WRITERS = ["openPrImpl", "pushBranchImpl", "updatePrBranchImpl", "pushToMainImpl"];

const src = readFileSync(FILE, "utf8");

const declRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm;
const decls = [...src.matchAll(declRe)].map((m) => ({ name: m[1], index: m.index }));

const failures = [];

for (const name of WRITERS) {
  const i = decls.findIndex((d) => d.name === name);
  if (i === -1) {
    failures.push(`${name}: function not found in ${FILE} (renamed or removed? update WRITERS)`);
    continue;
  }
  const start = decls[i].index;
  const end = i + 1 < decls.length ? decls[i + 1].index : src.length;
  const body = src.slice(start, end);

  if (!/await\s+assertDependencyAdmission\s*\(\s*files\b/.test(body)) {
    failures.push(
      `${name}: does not call 'await assertDependencyAdmission(files, ...)'. ` +
        `Every path that can write package.json into a customer repo must check admission first.`,
    );
  }
}

if (failures.length > 0) {
  for (const f of failures) console.log(`::error::dependency admission gate: ${f}`);
  process.exit(1);
}

console.log(`OK — dependency admission wired into all ${WRITERS.length} repo writers.`);
