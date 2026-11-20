import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { planBlindPack, writeBlindPack, unblind } from "../lib/blind.mjs";
import { loadBriefs, loadRecordEntries, MOCK_DIR } from "../lib/io.mjs";
import { solidPng, stripPngMetadata, pngSize } from "../lib/png.mjs";
import { SCORE_AXES } from "../lib/schema.mjs";
import { allFiles, baseRecord, grepDir, tmp } from "./helpers.mjs";

const briefs = loadBriefs();
const briefIds = briefs.map((b) => b.id);

function withText(png, keyword, text) {
  const data = Buffer.from(`${keyword}\0${text}`, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from("tEXt"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([png.subarray(0, 33), len, body, crc, png.subarray(33)]);
}

function evidenceSet() {
  const dir = tmp("sqb-ev-");
  mkdirSync(join(dir, "shots"));
  briefIds.forEach((brief, i) => {
    for (const system of ["zavi", "lovable"]) {
      const run_id = `${system === "zavi" ? "zrun" : "lrun"}-${brief}`;
      for (const vp of ["desktop", "mobile"]) {
        const png = withText(solidPng(8 + i, vp === "desktop" ? 5 : 9, [i * 30, system === "zavi" ? 10 : 200, 50]), "Software", `${system} capture ${run_id}`);
        writeFileSync(join(dir, "shots", `${run_id}-${vp}.png`), png);
      }
      const rec = baseRecord({
        run_id,
        brief_id: brief,
        system,
        provenance: system === "zavi" ? "actual_ai_build" : "manual_import",
        screenshots: { desktop: `shots/${run_id}-desktop.png`, mobile: `shots/${run_id}-mobile.png` },
      });
      writeFileSync(join(dir, `${run_id}.record.json`), JSON.stringify(rec));
    }
  });
  const { entries, errors } = loadRecordEntries([dir], { briefIds });
  expect(errors).toEqual([]);
  return { dir, entries };
}

function pack(entries, seed, extra = {}) {
  const root = tmp("sqb-pack-");
  const outDir = join(root, "pack");
  const keyPath = join(root, "sealed", "key.json");
  const res = writeBlindPack({ entries, briefs, outDir, keyPath, seed, systems: ["zavi", "lovable"], packId: "pack-fixed", now: new Date("2026-10-07T00:00:00Z"), ...extra });
  return { ...res, outDir, keyPath, root };
}

describe("blind-pack", () => {
  it("is deterministic for a seed: same mapping, same sheet bytes, same images", () => {
    const { entries } = evidenceSet();
    const a = pack(entries, "seed-123");
    const b = pack(entries, "seed-123");
    expect(b.key.items).toEqual(a.key.items);
    expect(readFileSync(join(b.outDir, "rate.html"))).toEqual(readFileSync(join(a.outDir, "rate.html")));
    const files = allFiles(a.outDir).map((f) => f.slice(a.outDir.length));
    expect(allFiles(b.outDir).map((f) => f.slice(b.outDir.length))).toEqual(files);
    for (const f of files) expect(readFileSync(join(b.outDir, f))).toEqual(readFileSync(join(a.outDir, f)));
  });

  it("actually shuffles: across seeds both systems land on side A, and brief order changes", () => {
    const { entries } = evidenceSet();
    const sidesA = new Set();
    const orders = new Set();
    for (let s = 0; s < 12; s++) {
      const { items } = planBlindPack(entries, { seed: `s${s}` });
      items.forEach((it) => sidesA.add(it.A.record.system));
      orders.add(items.map((it) => it.brief_id).join(","));
    }
    expect(sidesA).toEqual(new Set(["zavi", "lovable"]));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("keeps the key out of the rater pack: no system, run id, seed, provenance or key file inside", () => {
    const { entries } = evidenceSet();
    const p = pack(entries, "very-secret-seed");
    expect(existsSync(p.keyPath)).toBe(true);
    expect(allFiles(p.outDir).some((f) => f.endsWith("key.json"))).toBe(false);
    const needles = ["zavi", "lovable", "very-secret-seed", "actual_ai_build", "manual_import", "provenance", "record.json", ...entries.map((e) => e.record.run_id)];
    for (const n of needles) expect({ n, hits: grepDir(p.outDir, n) }).toEqual({ n, hits: [] });
    const key = JSON.parse(readFileSync(p.keyPath, "utf8"));
    expect(key.seed).toBe("very-secret-seed");
    expect(key.items).toHaveLength(6);
  });

  it("each pack image is the stripped screenshot of the record the key names for that side", () => {
    const { entries } = evidenceSet();
    const p = pack(entries, "map-check");
    const byRun = Object.fromEntries(entries.map((e) => [e.record.run_id, e]));
    for (const it of p.key.items) {
      for (const side of ["A", "B"]) {
        for (const vp of ["desktop", "mobile"]) {
          const src = join(byRun[it[side].run_id].file, "..", byRun[it[side].run_id].record.screenshots[vp]);
          const got = readFileSync(join(p.outDir, "images", `${it.item_id}-${side}-${vp}.png`));
          expect(got).toEqual(stripPngMetadata(readFileSync(src)));
          expect(pngSize(got)).toEqual(pngSize(readFileSync(src)));
        }
      }
    }
  });

  it("refuses a key path inside the pack and a non-empty output dir", () => {
    const { entries } = evidenceSet();
    const root = tmp();
    expect(() => writeBlindPack({ entries, briefs, outDir: join(root, "p"), keyPath: join(root, "p", "key.json"), seed: "x", systems: ["zavi", "lovable"] })).toThrow(/outside the rater pack/);
    expect(() => writeBlindPack({ entries, briefs, outDir: join(root, "p"), keyPath: join(root, "p", "sub", "k.json"), seed: "x", systems: ["zavi", "lovable"] })).toThrow(/outside the rater pack/);
    expect(existsSync(join(root, "p"))).toBe(false);
    mkdirSync(join(root, "full"));
    writeFileSync(join(root, "full", "x"), "1");
    expect(() => writeBlindPack({ entries, briefs, outDir: join(root, "full"), keyPath: join(root, "k.json"), seed: "x", systems: ["zavi", "lovable"] })).toThrow(/not empty/);
  });

  it("excludes mocked records unless allowed, and flags a practice pack", () => {
    const { entries } = loadRecordEntries([MOCK_DIR], { briefIds });
    expect(() => pack(entries, "m")).toThrow(/--allow-mocked/);
    const p = pack(entries, "m", { allowNonEvidence: true });
    expect(p.key.contains_non_evidence).toBe(true);
    expect(readFileSync(join(p.outDir, "rate.html"), "utf8")).toMatch(/practice only, not evidence/);
  });

  it("skips briefs missing one side and says why", () => {
    const { entries } = evidenceSet();
    const partial = entries.filter((e) => !(e.record.brief_id === "tattoo-studio" && e.record.system === "lovable"));
    const p = pack(partial, "sk");
    expect(p.key.items.map((i) => i.brief_id)).not.toContain("tattoo-studio");
    expect(p.key.skipped).toEqual([{ brief_id: "tattoo-studio", reason: "no evidence record with both screenshots for lovable" }]);
  });
});

function fullScores(v) {
  return Object.fromEntries(SCORE_AXES.map((a) => [a, v]));
}

describe("unblind", () => {
  it("joins every rated side back to the right run and turns preference into win/loss/tie", () => {
    const { entries } = evidenceSet();
    const p = pack(entries, "join-seed");
    const orientations = new Set(p.key.items.map((i) => i.A.system));
    expect(orientations).toEqual(new Set(["zavi", "lovable"]));
    const prefs = ["A", "B", "tie", null, "A", "B"];
    const doc = {
      pack_id: "pack-fixed",
      rater: "rater-1",
      ratings: p.key.items.map((it, i) => ({ item_id: it.item_id, viewport: "desktop", A: fullScores(5), B: { ...fullScores(1), imagery: null }, preference: prefs[i] })),
    };
    const { rows, errors } = unblind(p.key, [doc]);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(12);
    p.key.items.forEach((it, i) => {
      const a = rows.find((r) => r.item_id === it.item_id && r.side === "A");
      const b = rows.find((r) => r.item_id === it.item_id && r.side === "B");
      expect(a.run_id).toBe(it.A.run_id);
      expect(a.system).toBe(it.A.system);
      expect(a.opponent_run_id).toBe(it.B.run_id);
      expect(a.scores).toEqual({ rater: "rater-1", ...fullScores(5) });
      expect(b.run_id).toBe(it.B.run_id);
      expect(b.scores).toEqual({ rater: "rater-1", ...fullScores(1), imagery: null });
      const expected = { A: ["win", "loss"], B: ["loss", "win"], tie: ["tie", "tie"], null: [null, null] }[String(prefs[i])];
      expect([a.outcome, b.outcome]).toEqual(expected);
    });
    const zaviHigh = rows.filter((r) => r.system === "zavi" && r.scores.hierarchy === 5).map((r) => r.item_id);
    expect(zaviHigh).toEqual(p.key.items.filter((it) => it.A.system === "zavi").map((it) => it.item_id));
  });

  it("rejects a ratings file from another pack, unknown items, duplicates, bad scores and missing rater", () => {
    const { entries } = evidenceSet();
    const p = pack(entries, "bad");
    const it = p.key.items[0];
    const ok = { item_id: it.item_id, viewport: "mobile", A: {}, B: {}, preference: "A" };
    expect(unblind(p.key, [{ pack_id: "other", rater: "r", ratings: [ok] }]).errors[0]).toMatch(/does not match key/);
    expect(unblind(p.key, [{ pack_id: "pack-fixed", rater: "", ratings: [ok] }]).errors[0]).toMatch(/rater is required/);
    const { errors, rows } = unblind(p.key, [
      {
        pack_id: "pack-fixed",
        rater: "r",
        ratings: [ok, ok, { ...ok, item_id: "item-99" }, { ...ok, viewport: "tablet" }, { ...ok, viewport: "desktop", A: { spacing: 7 }, preference: "C" }],
      },
    ]);
    expect(errors).toEqual([
      expect.stringMatching(/ratings\[1\]: duplicate rating/),
      expect.stringMatching(/unknown item_id item-99/),
      expect.stringMatching(/unknown viewport tablet/),
      expect.stringMatching(/preference must be A, B, tie or null/),
      expect.stringMatching(/A\.spacing must be 1-5 or null/),
    ]);
    expect(rows.filter((r) => r.viewport === "mobile")).toHaveLength(2);
  });

  it("two raters on the same item are both kept", () => {
    const { entries } = evidenceSet();
    const p = pack(entries, "two");
    const r = (rater) => ({ pack_id: "pack-fixed", rater, ratings: [{ item_id: p.key.items[0].item_id, viewport: "desktop", A: {}, B: {}, preference: "tie" }] });
    const { rows, errors } = unblind(p.key, [r("a"), r("b")]);
    expect(errors).toEqual([]);
    expect(rows.map((x) => x.rater)).toEqual(["a", "a", "b", "b"]);
  });
});
