
export function xlTreeThresholdKb(): number {
  const n = Number(process.env.E2B_XL_TREE_THRESHOLD_KB);
  return Number.isFinite(n) && n > 0 ? n : 2_000_000;
}

export function pickSandboxTemplate(
  measuredTreeKb: number | null | undefined,
): string | null {
  const xl = process.env.E2B_XL_TEMPLATE?.trim();
  if (!xl) return null;
  if (measuredTreeKb != null && measuredTreeKb > xlTreeThresholdKb()) {
    return xl;
  }
  return null;
}
