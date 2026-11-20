export function envFlagOn(value: string | undefined): boolean {
  return ["1", "true"].includes((value ?? "").trim().toLowerCase());
}
