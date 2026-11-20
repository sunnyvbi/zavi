import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT } from "./lib/paths.mjs";

const MUTATIONS = [
  { n: "19", what: "order requests readable by every signed-in user", expect: "other_baker.cannot_see_request", apply: (m) => Object.assign(m.collections.order_requests.rules, { list: ["signed_in"], get: ["signed_in"] }) },
  { n: "02", what: "no unique slot", expect: "unique.second_booking_same_slot_refused", apply: (m) => { m.collections.bookings.unique = []; } },
  { n: "11", what: "rent bound far above stock", expect: "bound.b_refused_when_out_of_stock", apply: (m) => { m.actions.rent_shoe.bounds = { min: 0, max: 1000 }; } },
  { n: "06", what: "pending guestbook entries public", expect: "moderation.pending_hidden_from_visitor", apply: (m) => { m.collections.guestbook.states.read.pending = ["anyone"]; } },
];

const dir = mkdtempSync(join(tmpdir(), "kk-mut-"));
cpSync(KIT, dir, { recursive: true, filter: (p) => !p.includes("/.state") && !p.includes("/results") });
const out = [];
try {
  for (const mu of MUTATIONS) {
    const p = join(dir, "sites", mu.n, "zavi-site.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    mu.apply(m);
    writeFileSync(p, JSON.stringify(m));
    const r = spawnSync(process.execPath, [...process.execArgv, join(dir, "journeys", `${mu.n}.mjs`), `dev:mut${mu.n}`], { env: process.env, encoding: "utf8" });
    let fails = [];
    try { fails = JSON.parse(r.stdout).steps.filter((s) => s.status === "fail").map((s) => s.id); } catch { fails = ["<no JSON>"]; }
    out.push({ n: mu.n, broke: mu.what, caught: r.status !== 0 && fails.includes(mu.expect), failed_steps: fails });
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify({ mode: "DEV self-check of the kit, not the kill test", mutations: out }, null, 2));
process.exit(out.every((o) => o.caught) ? 0 : 1);
