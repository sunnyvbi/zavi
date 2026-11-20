import { describe, it, expect } from "vitest";
import { parseEnvFile, parseMemoryFree, parityVerdict, readManifest } from "../cli";

describe("seed-scan CLI helpers", () => {
  it("reads KEY=VALUE env files, skipping comments and stripping quotes", () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two"\nC=\'3=3\'\nbad line\n')).toEqual({ A: "1", B: "two", C: "3=3" });
  });
  it("reads macOS free-memory percentage", () => {
    expect(parseMemoryFree("...\nSystem-wide memory free percentage: 41%\n")).toBe(41);
    expect(parseMemoryFree("garbage")).toBe(100);
  });
  it("validates the manifest", () => {
    expect(readManifest('[{"domain":"a.com","source":"yc"}]')).toEqual([{ domain: "a.com", source: "yc" }]);
    expect(() => readManifest('[{"domain":"a.com","source":"web"}]')).toThrow(/source/);
    expect(() => readManifest('{"domain":"a.com"}')).toThrow(/array/);
  });
  it("parity passes only when renders and search terms agree", () => {
    const ok = Array.from({ length: 10 }, (_, i) => ({ renderDelta: i % 2 ? 1 : -1, termMatch: i < 7 }));
    expect(parityVerdict(ok).pass).toBe(true);
    expect(parityVerdict(ok.map((r) => ({ ...r, renderDelta: 3 }))).pass).toBe(false);
    expect(parityVerdict(ok.map((r, i) => ({ ...r, termMatch: i < 5 }))).pass).toBe(false);
    expect(parityVerdict(ok.map((r, i) => ({ ...r, renderDelta: i < 6 ? null : 0 }))).pass).toBe(false);
  });
});

import { checkRef, insideRepo } from "../cli";
describe("seed-scan guards", () => {
  it("accepts only the expected Supabase project", () => {
    expect(checkRef("https://wmycgyjsenvgtczlupoe.supabase.co", "wmycgyjsenvgtczlupoe")).toBe("wmycgyjsenvgtczlupoe");
    expect(() => checkRef("https://dgzgwclslzzzrjopbobp.supabase.co", "wmycgyjsenvgtczlupoe")).toThrow(/expected/);
    expect(() => checkRef("http://localhost:54321", "wmycgyjsenvgtczlupoe")).toThrow(/not a supabase/);
  });
  it("refuses an env file inside the repo", () => {
    expect(insideRepo("/r/apps/backend/.env", "/r")).toBe(true);
    expect(insideRepo("/r", "/r")).toBe(true);
    expect(insideRepo("/rx/.env", "/r")).toBe(false);
    expect(insideRepo("/Users/me/.zavi/seed.env", "/r")).toBe(false);
  });
});

import { positiveInt } from "../cli";
describe("numeric flags", () => {
  it("rejects NaN, zero, negatives and fractions", () => {
    expect(positiveInt("3", "--x")).toBe(3);
    for (const v of ["nope", "0", "-1", "1.5", ""]) expect(() => positiveInt(v, "--x"), v).toThrow(/--x/);
  });
});
