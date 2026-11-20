export function numericValues(values) {
  const nums = [];
  let nulls = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
    else nulls++;
  }
  return { nums: nums.sort((a, b) => a - b), nulls };
}

export function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function p90(sorted) {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

export function mean(sorted) {
  if (sorted.length === 0) return null;
  return sorted.reduce((a, b) => a + b, 0) / sorted.length;
}

export function summarize(values) {
  const { nums, nulls } = numericValues(values);
  return { n: nums.length, nulls, median: median(nums), p90: p90(nums), mean: mean(nums) };
}

export function ratio(num, den) {
  return den > 0 ? num / den : null;
}
