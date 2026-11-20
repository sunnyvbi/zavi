
import type { ShardRow } from "./contract";
import type { CpuMetricsSource, CpuSample } from "./metrics";
import type { ShardSecretStore } from "./registry";

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

const MAX_SAMPLE_GAP_MS = 3600_000;

export function parseCpu(text: string): { idle_s: number; total_s: number; ncpu: number; load1: number | null } {
  let idle = 0;
  let total = 0;
  let load1: number | null = null;
  const cpus = new Set<string>();
  const lines = text.split("\n");
  const scoped = lines.some((l) => l.startsWith("node_cpu_seconds_total{") && /service_type="/.test(l));
  for (const line of lines) {
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([^\s]+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[3] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2];
    const v = Number(m[4]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === "node_cpu_seconds_total") {
      if (scoped && labels.service_type !== "db") continue;
      total += v;
      if (labels.mode === "idle") idle += v;
      if (labels.cpu !== undefined) cpus.add(labels.cpu);
    } else if (m[1] === "node_load1" && (!labels.service_type || labels.service_type === "db")) {
      load1 = v;
    }
  }
  if (total <= 0) throw new Error("metrics endpoint: no node_cpu_seconds_total");
  return { idle_s: idle, total_s: total, ncpu: Math.max(1, cpus.size), load1 };
}

export function cpuPct(cur: CpuSample, prev: CpuSample | null, load1: number | null): number {
  const clamp = (x: number) => Math.min(100, Math.max(0, x));
  if (prev && cur.at_ms > prev.at_ms && cur.at_ms - prev.at_ms <= MAX_SAMPLE_GAP_MS && cur.ncpu === prev.ncpu) {
    const dt = cur.total_s - prev.total_s;
    const di = cur.idle_s - prev.idle_s;
    if (dt > 0 && di >= 0 && di <= dt) return clamp(100 * (1 - di / dt));
  }
  if (load1 === null) throw new Error("metrics endpoint: no previous sample and no node_load1");
  return clamp((100 * load1) / cur.ncpu);
}

export function createCpuMetricsSource(deps: { secrets: Pick<ShardSecretStore, "getSecret">; fetchFn?: Fetch; now?: () => number }): CpuMetricsSource {
  const fetchFn: Fetch = deps.fetchFn ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<Fetch>);
  const now = deps.now ?? Date.now;
  return {
    async read(shard: ShardRow, prev: CpuSample | null) {
      const ref = shard.project_ref ?? "";
      if (!/^[a-z0-9]{8,40}$/.test(ref)) throw new Error("cpu metrics: shard has no project ref");
      const key = await deps.secrets.getSecret(shard.id, "service_key");
      if (!key) throw new Error("cpu metrics: shard service key not in Vault");
      const res = await fetchFn(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, {
        method: "GET",
        headers: { Authorization: `Basic ${Buffer.from(`service_role:${key}`).toString("base64")}`, Accept: "text/plain" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`cpu metrics: endpoint returned ${res.status}`);
      const p = parseCpu(await res.text());
      const at = now();
      const sample: CpuSample = { idle_s: p.idle_s, total_s: p.total_s, at_ms: at, ncpu: p.ncpu };
      return { cpu_pct: cpuPct(sample, prev, p.load1), sample, measured_at: new Date(at).toISOString() };
    },
  };
}
