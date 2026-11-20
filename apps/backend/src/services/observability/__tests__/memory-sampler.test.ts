
import { describe, it, expect } from "vitest";
import {
  parseProcStatus,
  parseCgroupV2Bytes,
  percentile,
  computeSafeConcurrency,
  cmdlineLooksLikeClaude,
  mergePeak,
} from "../memory-sampler";

describe("parseProcStatus", () => {
  it("extracts Name + VmRSS (kB → MB)", () => {
    const status = [
      "Name:\tclaude",
      "Umask:\t0022",
      "State:\tR (running)",
      "VmPeak:\t 2097152 kB",
      "VmRSS:\t 1048576 kB",
      "Threads:\t12",
    ].join("\n");
    expect(parseProcStatus(status)).toEqual({ name: "claude", rssMb: 1024 });
  });

  it("matches the truncated comm for a long binary name", () => {
    const status = "Name:\tclaude\nVmRSS:\t  512000 kB\n";
    expect(parseProcStatus(status)?.name).toBe("claude");
    expect(parseProcStatus(status)?.rssMb).toBe(500);
  });

  it("returns null when VmRSS is absent (kernel thread)", () => {
    expect(parseProcStatus("Name:\tkworker/0:1\nState:\tI\n")).toBeNull();
  });

  it("returns null when Name is absent", () => {
    expect(parseProcStatus("VmRSS:\t100 kB\n")).toBeNull();
  });
});

describe("parseCgroupV2Bytes", () => {
  it("parses a plain byte count to MB", () => {
    expect(parseCgroupV2Bytes("3221225472")).toBe(3072);
  });
  it("treats 'max' (unlimited) as null", () => {
    expect(parseCgroupV2Bytes("max")).toBeNull();
  });
  it("handles trailing newline", () => {
    expect(parseCgroupV2Bytes("1073741824\n")).toBe(1024);
  });
  it("returns null on garbage / empty", () => {
    expect(parseCgroupV2Bytes("")).toBeNull();
    expect(parseCgroupV2Bytes("notanumber")).toBeNull();
  });
  it("rejects a partial/mixed read instead of silently truncating (the prosecutor bug)", () => {
    expect(parseCgroupV2Bytes("123garbage")).toBeNull();
    expect(parseCgroupV2Bytes("3221225472 extra")).toBeNull();
  });
});

describe("cmdlineLooksLikeClaude", () => {
  it("matches the bundled SDK binary path (argv0 ends /claude)", () => {
    expect(
      cmdlineLooksLikeClaude(
        "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude\0--print\0",
      ),
    ).toBe(true);
  });
  it("matches when the package name appears anywhere in cmdline", () => {
    expect(cmdlineLooksLikeClaude("node\0/x/claude-agent-sdk/cli.js")).toBe(true);
  });
  it("does not match an unrelated proc", () => {
    expect(cmdlineLooksLikeClaude("/usr/bin/node\0server.js")).toBe(false);
    expect(cmdlineLooksLikeClaude("postgres: writer process")).toBe(false);
  });
});

describe("mergePeak (window-peak reducer)", () => {
  const s = (over: Partial<import("../memory-sampler").MemorySample>) => ({
    container_role: "canonical",
    cgroup_current_mb: 1000,
    cgroup_peak_mb: 1000,
    cgroup_max_mb: 3072,
    node_rss_mb: 400,
    claude_proc_count: 1,
    claude_rss_max_mb: 900,
    claude_rss_sum_mb: 900,
    ...over,
  });
  it("seeds from the first sample", () => {
    expect(mergePeak(null, s({}))).toEqual(s({}));
  });
  it("takes element-wise max across the window", () => {
    const a = s({ cgroup_current_mb: 1000, claude_proc_count: 1, claude_rss_max_mb: 900, node_rss_mb: 400 });
    const b = s({ cgroup_current_mb: 2200, claude_proc_count: 2, claude_rss_max_mb: 1300, node_rss_mb: 450 });
    const m = mergePeak(a, b);
    expect(m.cgroup_current_mb).toBe(2200);
    expect(m.claude_proc_count).toBe(2);
    expect(m.claude_rss_max_mb).toBe(1300);
    expect(m.node_rss_mb).toBe(450);
  });
  it("treats null as no-value (max(null,x)=x) and keeps latest known cgroup_max", () => {
    const a = s({ claude_rss_max_mb: null, claude_rss_sum_mb: null, cgroup_max_mb: 3072 });
    const b = s({ claude_rss_max_mb: 1100, claude_rss_sum_mb: 1100, cgroup_max_mb: null });
    const m = mergePeak(a, b);
    expect(m.claude_rss_max_mb).toBe(1100);
    expect(m.cgroup_max_mb).toBe(3072);
  });
});

describe("percentile", () => {
  it("nearest-rank percentiles", () => {
    const v = [10, 20, 30, 40, 50];
    expect(percentile(v, 50)).toBe(30);
    expect(percentile(v, 100)).toBe(50);
    expect(percentile(v, 0)).toBe(10);
  });
  it("is order-independent", () => {
    expect(percentile([50, 10, 40, 20, 30], 95)).toBe(50);
  });
  it("returns null on empty", () => {
    expect(percentile([], 95)).toBeNull();
  });
});

describe("computeSafeConcurrency", () => {
  it("floors (limit - headroom) / per_proc_rss", () => {
    expect(computeSafeConcurrency(6144, 600, 1024)).toBe(5);
  });

  it("matches the current 3g box reality (the why-it-is-2 check)", () => {
    expect(computeSafeConcurrency(3072, 600, 1100)).toBe(2);
  });

  it("never returns below 1, even when a single proc exceeds usable RAM", () => {
    expect(computeSafeConcurrency(1024, 600, 2000)).toBe(1);
  });

  it("returns 1 when headroom exceeds the limit (never 0/negative → no deadlock)", () => {
    expect(computeSafeConcurrency(500, 600, 200)).toBe(1);
  });

  it("returns null on unusable inputs", () => {
    expect(computeSafeConcurrency(NaN, 600, 1000)).toBeNull();
    expect(computeSafeConcurrency(6144, 600, 0)).toBeNull();
    expect(computeSafeConcurrency(6144, 600, -5)).toBeNull();
  });
});
