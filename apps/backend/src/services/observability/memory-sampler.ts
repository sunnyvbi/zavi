
import { promises as fs } from "node:fs";
import { serviceClient } from "@/services/supabase";

const SAMPLE_INTERVAL_MS = 5_000;
const FLUSH_EVERY_TICKS = 6;

const CLAUDE_PROC_NAMES = new Set(["claude"]);

const BYTES_PER_MB = 1024 * 1024;

export function parseProcStatus(
  content: string,
): { name: string; rssMb: number } | null {
  let name: string | null = null;
  let rssKb: number | null = null;
  for (const line of content.split("\n")) {
    if (name === null && line.startsWith("Name:")) {
      name = line.slice(5).trim();
    } else if (rssKb === null && line.startsWith("VmRSS:")) {
      const m = line.match(/VmRSS:\s*(\d+)\s*kB/);
      if (m) rssKb = Number.parseInt(m[1], 10);
    }
    if (name !== null && rssKb !== null) break;
  }
  if (name === null || rssKb === null || !Number.isFinite(rssKb)) return null;
  return { name, rssMb: Math.round(rssKb / 1024) };
}

export function parseCgroupV2Bytes(content: string): number | null {
  const t = content.trim();
  if (t === "" || t === "max") return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n / BYTES_PER_MB);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function computeSafeConcurrency(
  memLimitMb: number,
  nodeHeadroomMb: number,
  perProcRssMb: number,
): number | null {
  if (
    !Number.isFinite(memLimitMb) ||
    !Number.isFinite(nodeHeadroomMb) ||
    !Number.isFinite(perProcRssMb) ||
    perProcRssMb <= 0
  ) {
    return null;
  }
  const usable = memLimitMb - nodeHeadroomMb;
  if (usable <= 0) return 1;
  return Math.max(1, Math.floor(usable / perProcRssMb));
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function readCgroupMemory(): Promise<{
  currentMb: number | null;
  peakMb: number | null;
  maxMb: number | null;
}> {
  const v2current = await readFileSafe("/sys/fs/cgroup/memory.current");
  if (v2current !== null) {
    return {
      currentMb: parseCgroupV2Bytes(v2current),
      peakMb: parseCgroupV2Bytes(
        (await readFileSafe("/sys/fs/cgroup/memory.peak")) ?? "",
      ),
      maxMb: parseCgroupV2Bytes(
        (await readFileSafe("/sys/fs/cgroup/memory.max")) ?? "",
      ),
    };
  }
  const v1usage = await readFileSafe(
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  );
  if (v1usage !== null) {
    const limit = parseCgroupV2Bytes(
      (await readFileSafe("/sys/fs/cgroup/memory/memory.limit_in_bytes")) ?? "",
    );
    const maxMb = limit !== null && limit < 1_000_000 ? limit : null;
    return {
      currentMb: parseCgroupV2Bytes(v1usage),
      peakMb: parseCgroupV2Bytes(
        (await readFileSafe(
          "/sys/fs/cgroup/memory/memory.max_usage_in_bytes",
        )) ?? "",
      ),
      maxMb,
    };
  }
  return { currentMb: null, peakMb: null, maxMb: null };
}

export function cmdlineLooksLikeClaude(cmdline: string): boolean {
  const argv0 = cmdline.split("\0")[0] ?? "";
  return /\/claude$/.test(argv0) || cmdline.includes("claude-agent-sdk");
}

export async function readClaudeProcRssMb(): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const content = await readFileSafe(`/proc/${ent}/status`);
    if (content === null) continue;
    const parsed = parseProcStatus(content);
    if (!parsed) continue;
    let isClaude = CLAUDE_PROC_NAMES.has(parsed.name);
    if (!isClaude) {
      const cmdline = await readFileSafe(`/proc/${ent}/cmdline`);
      if (cmdline !== null && cmdlineLooksLikeClaude(cmdline)) isClaude = true;
    }
    if (isClaude) out.push(parsed.rssMb);
  }
  return out;
}

export type MemorySample = {
  container_role: string;
  cgroup_current_mb: number | null;
  cgroup_peak_mb: number | null;
  cgroup_max_mb: number | null;
  node_rss_mb: number;
  claude_proc_count: number;
  claude_rss_max_mb: number | null;
  claude_rss_sum_mb: number | null;
};

export async function sampleOnce(): Promise<MemorySample> {
  const [cgroup, claudeRss] = await Promise.all([
    readCgroupMemory(),
    readClaudeProcRssMb(),
  ]);
  return {
    container_role: process.env.PRAXIS_CONTAINER_ROLE ?? "unknown",
    cgroup_current_mb: cgroup.currentMb,
    cgroup_peak_mb: cgroup.peakMb,
    cgroup_max_mb: cgroup.maxMb,
    node_rss_mb: Math.round(process.memoryUsage().rss / BYTES_PER_MB),
    claude_proc_count: claudeRss.length,
    claude_rss_max_mb: claudeRss.length ? Math.max(...claudeRss) : null,
    claude_rss_sum_mb: claudeRss.length
      ? claudeRss.reduce((a, b) => a + b, 0)
      : null,
  };
}

export function mergePeak(
  acc: MemorySample | null,
  next: MemorySample,
): MemorySample {
  if (!acc) return { ...next };
  const maxN = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);
  return {
    container_role: next.container_role,
    cgroup_current_mb: maxN(acc.cgroup_current_mb, next.cgroup_current_mb),
    cgroup_peak_mb: maxN(acc.cgroup_peak_mb, next.cgroup_peak_mb),
    cgroup_max_mb: next.cgroup_max_mb ?? acc.cgroup_max_mb,
    node_rss_mb: Math.max(acc.node_rss_mb, next.node_rss_mb),
    claude_proc_count: Math.max(acc.claude_proc_count, next.claude_proc_count),
    claude_rss_max_mb: maxN(acc.claude_rss_max_mb, next.claude_rss_max_mb),
    claude_rss_sum_mb: maxN(acc.claude_rss_sum_mb, next.claude_rss_sum_mb),
  };
}

let started = false;

export function startMemorySampler(): void {
  if (started) return;
  if (process.env.RUNTIME_MEMORY_SAMPLING === "0") {
    console.log("[memory-sampler] disabled (RUNTIME_MEMORY_SAMPLING=0)");
    return;
  }
  const role = process.env.PRAXIS_CONTAINER_ROLE;
  if (role && role !== "canonical") {
    console.log(`[memory-sampler] skipped — role=${role} (not canonical)`);
    return;
  }
  started = true;

  let windowPeak: MemorySample | null = null;
  let tickCount = 0;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      windowPeak = mergePeak(windowPeak, await sampleOnce());
      if (++tickCount < FLUSH_EVERY_TICKS) return;
      tickCount = 0;
      const peak = windowPeak;
      windowPeak = null;
      if (!peak || peak.claude_proc_count === 0) return;
      const { error } = await serviceClient()
        .from("runtime_memory_samples")
        .insert(peak);
      if (error) {
        console.warn(`[memory-sampler] insert failed (non-fatal): ${error.message}`);
      }
    } catch (e) {
      console.warn(
        `[memory-sampler] tick failed (non-fatal): ${(e as Error).message}`,
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS);
  timer.unref();
  console.log(
    `[memory-sampler] started — sample ${SAMPLE_INTERVAL_MS / 1000}s, flush peak every ${(SAMPLE_INTERVAL_MS * FLUSH_EVERY_TICKS) / 1000}s, role=${role ?? "(unset)"}`,
  );
}
