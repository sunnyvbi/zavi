export function moneyBookShadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.AD_MONEY_BOOK_SHADOW === "0") return false;
  if (env.VITEST && env.AD_MONEY_BOOK_SHADOW !== "1") return false;
  return true;
}
