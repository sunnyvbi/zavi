const PLACEHOLDER: readonly RegExp[] = [
  /\b(test|fake|example|dummy|placeholder)\s+(street|st|road|rd|avenue|ave|lane|ln|way|drive|dr|boulevard|blvd|place|pl)\b/i,
  /\b(lorem|ipsum|placeholder|tbd|tba|todo)\b/i,
  /\banytown\b/i,
  /\byour\s+(\w+\s+)?address\b/i,
  /\bcity\b[\s\S]*\b(state|zip)\b/i,
  /x{3,}/i,
  /^[^\p{L}]*$/u,
];

export function isPlaceholderPostalAddress(value: string): boolean {
  const text = value.trim();
  return text !== "" && PLACEHOLDER.some((re) => re.test(text));
}
