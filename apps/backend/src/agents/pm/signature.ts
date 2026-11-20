
export function normSignature(error: string | null | undefined): string {
  if (!error) return "";
  return error
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
