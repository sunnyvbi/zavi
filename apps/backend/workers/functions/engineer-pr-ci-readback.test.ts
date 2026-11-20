import { describe, it, expect } from "vitest";
import {
  parsePrUrl,
  decideCiVerdict,
  applyCiToNotice,
  ciStatusLine,
  type CheckReadout,
} from "./engineer-pr-ci-readback";
import { buildVerifyStatusLine } from "./dispatch-notice";

describe("parsePrUrl", () => {
  it("parses owner/repo/number from a github PR url", () => {
    expect(parsePrUrl("https://github.com/rravi149/upcar/pull/1005")).toEqual({
      owner: "rravi149",
      repo: "upcar",
      pull_number: 1005,
    });
  });
  it("returns null on non-PR / malformed urls", () => {
    expect(parsePrUrl("https://github.com/rravi149/upcar")).toBeNull();
    expect(parsePrUrl("https://github.com/o/r/pull/abc")).toBeNull();
    expect(parsePrUrl(null)).toBeNull();
    expect(parsePrUrl(undefined)).toBeNull();
  });
});

describe("decideCiVerdict", () => {
  const readout = (over: Partial<CheckReadout>): CheckReadout => ({
    head_sha: "sha1",
    checks_total: 1,
    checks_green: true,
    check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
    ...over,
  });

  it("all checks completed + success → green", () => {
    expect(decideCiVerdict({ readout: readout({}), first_head_sha: "sha1" }).verdict).toBe("green");
  });

  it("any completed non-success → red", () => {
    const r = readout({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] });
    expect(decideCiVerdict({ readout: r, first_head_sha: "sha1" }).verdict).toBe("red");
  });

  it("a check still running → pending (keep polling)", () => {
    const r = readout({ check_runs: [{ name: "ci", status: "in_progress", conclusion: null }] });
    expect(decideCiVerdict({ readout: r, first_head_sha: "sha1" }).verdict).toBe("pending");
  });

  it("no checks at all → na (nothing to read)", () => {
    const r = readout({ checks_total: 0, check_runs: [] });
    expect(decideCiVerdict({ readout: r, first_head_sha: "sha1" }).verdict).toBe("na");
  });

  it("head SHA moved from first-observed → na (stale, PR advanced)", () => {
    const r = readout({ head_sha: "sha2" });
    expect(decideCiVerdict({ readout: r, first_head_sha: "sha1" }).verdict).toBe("na");
  });

  it("first observation (first_head_sha null) does not trip the stale guard", () => {
    const r = readout({ head_sha: "shaX" });
    const d = decideCiVerdict({ readout: r, first_head_sha: null });
    expect(d.verdict).toBe("green");
    expect(d.head_sha).toBe("shaX");
  });

  it("mixed: one green + one failed → red (any red dominates)", () => {
    const r = readout({
      check_runs: [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "completed", conclusion: "failure" },
      ],
    });
    expect(decideCiVerdict({ readout: r, first_head_sha: "sha1" }).verdict).toBe("red");
  });

  it("mixed: one success + one still running → pending", () => {
    const r = readout({
      check_runs: [
        { name: "a", status: "completed", conclusion: "success" },
        { name: "b", status: "queued", conclusion: null },
      ],
    });
    expect(decideCiVerdict({ readout: r, first_head_sha: "sha1" }).verdict).toBe("pending");
  });
});

describe("applyCiToNotice", () => {
  const base =
    "📬 Opened [o/r#12](https://github.com/o/r/pull/12) — fix thing\n`br` → `main`";

  it("replaces the current plain couldn't-run and failed lines (buildVerifyStatusLine shapes)", () => {
    for (const status of ["couldnt_run", "failed"] as const) {
      const line = buildVerifyStatusLine({ status, reason: "mongo" });
      const out = applyCiToNotice(`${base}\n${line}`, "green");
      expect(out).toBe(`${base}\n✅ CI green`);
    }
  });

  it("replaces the ⚠️ couldn't-run line with ✅ CI green", () => {
    const body = `${base}\n⚠️ couldn't run tests in sandbox: mongo — verify via your CI or locally`;
    const out = applyCiToNotice(body, "green");
    expect(out).toContain("✅ CI green");
    expect(out).not.toContain("couldn't run tests");
    expect(out).toContain("📬 Opened");
  });

  it("replaces the 🟡 tests-not-run line with ❌ CI red", () => {
    const body = `${base}\n🟡 tests not run`;
    const out = applyCiToNotice(body, "red");
    expect(out).toContain("❌ CI red");
    expect(out).not.toContain("tests not run");
  });

  it("replaces the ⚠️ tests-failed line", () => {
    const body = `${base}\n⚠️ tests failed — see the PR`;
    expect(applyCiToNotice(body, "green")).toContain("✅ CI green");
  });

  it("no verify status line present → appends the CI line (never drops it)", () => {
    const out = applyCiToNotice(base, "green");
    expect(out).toContain("✅ CI green");
    expect(out).toContain("📬 Opened");
  });

  it("idempotent — a body already ending in the CI line is unchanged", () => {
    const once = applyCiToNotice(`${base}\n🟡 tests not run`, "green");
    expect(applyCiToNotice(once, "green")).toBe(once);
  });

  it("ciStatusLine", () => {
    expect(ciStatusLine("green")).toBe("✅ CI green");
    expect(ciStatusLine("red")).toBe("❌ CI red");
  });
});
