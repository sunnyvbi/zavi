
export type MetricResult = {
  lever: string;
  numerator: number;
  denominator: number;
  window_days: number;
  numerator_window_days: number;
  denominator_window_days: number;
  join_matched?: number;
  join_attempted?: number;
  distinct_join_keys?: number;
  joined_rows?: number;
  null_count?: number;
  sampled_count?: number;
  independent_denominator?: number;
  query_id: string;
  source: string;
};

export type ContractProbe = { name: string; ok: boolean; reason?: string };
export type MetricContractVerdict = { passed: boolean; probes: ContractProbe[] };

const JOIN_COVERAGE_MIN = 0.5;
const DUP_EXPLOSION_MAX = 1.5;
const NULL_COVERAGE_MAX = 0.5;
const ROW_COUNT_TOLERANCE = 0.02;

export function checkMetricContract(m: MetricResult): MetricContractVerdict {
  const probes: ContractProbe[] = [];

  probes.push({
    name: "denominator_ge_numerator",
    ok: m.denominator >= m.numerator,
    reason:
      m.denominator >= m.numerator
        ? undefined
        : `numerator (${m.numerator}) exceeds denominator (${m.denominator}) — ratio > 1 is impossible; the two sides likely count different things`,
  });

  const sameWindow =
    m.numerator_window_days === m.window_days &&
    m.denominator_window_days === m.window_days;
  probes.push({
    name: "same_window",
    ok: sameWindow,
    reason: sameWindow
      ? undefined
      : `numerator window (${m.numerator_window_days}d) / denominator window (${m.denominator_window_days}d) differ from the metric window (${m.window_days}d)`,
  });

  if (m.join_attempted !== undefined && m.join_matched !== undefined && m.join_attempted > 0) {
    const cov = m.join_matched / m.join_attempted;
    probes.push({
      name: "join_coverage",
      ok: cov >= JOIN_COVERAGE_MIN,
      reason:
        cov >= JOIN_COVERAGE_MIN
          ? undefined
          : `join matched only ${(cov * 100).toFixed(0)}% of rows — the join key is probably mismatched`,
    });
  }

  if (m.joined_rows !== undefined && m.distinct_join_keys !== undefined && m.distinct_join_keys > 0) {
    const ratio = m.joined_rows / m.distinct_join_keys;
    probes.push({
      name: "dup_explosion",
      ok: ratio <= DUP_EXPLOSION_MAX,
      reason:
        ratio <= DUP_EXPLOSION_MAX
          ? undefined
          : `join fanned out ${ratio.toFixed(1)}× (rows-per-key) — a one-to-many join is inflating the count`,
    });
  }

  if (m.null_count !== undefined && m.sampled_count !== undefined && m.sampled_count > 0) {
    const nullFrac = m.null_count / m.sampled_count;
    probes.push({
      name: "null_coverage",
      ok: nullFrac <= NULL_COVERAGE_MAX,
      reason:
        nullFrac <= NULL_COVERAGE_MAX
          ? undefined
          : `${(nullFrac * 100).toFixed(0)}% of the key field is null — the metric is computed over mostly-empty data`,
    });
  }

  if (m.independent_denominator !== undefined && m.denominator > 0) {
    const drift = Math.abs(m.independent_denominator - m.denominator) / m.denominator;
    probes.push({
      name: "row_count_cross_check",
      ok: drift <= ROW_COUNT_TOLERANCE,
      reason:
        drift <= ROW_COUNT_TOLERANCE
          ? undefined
          : `an independent count (${m.independent_denominator}) disagrees with the denominator (${m.denominator}) by ${(drift * 100).toFixed(0)}%`,
    });
  }

  return { passed: probes.every((p) => p.ok), probes };
}
