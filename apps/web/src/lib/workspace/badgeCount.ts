
export function capBadgeCount(n: number, cap = 99): string {
  return n > cap ? `${cap}+` : String(n);
}

export function exactCountLabel(n: number, noun = "pending approval"): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

