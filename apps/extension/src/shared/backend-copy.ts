
export const SUPPORTED_DASHBOARDS = ["Meta Ads Manager"];

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function unrecognizedPageText(
  supported: string[] = SUPPORTED_DASHBOARDS,
): string {
  return [
    "I do not recognize this page, so I am not going to guess at what is on it.",
    `The dashboards I can read today: ${joinList(supported)}.`,
    "Open one of those and ask me again, and I will work from what is on your screen plus what I already know about your business.",
  ].join(" ");
}

export function groundedRefusalText(): string {
  return [
    "I can see your screen, but I could not tie it back to anything I know about your business.",
    "Rather than hand you a recommendation I cannot stand behind, I am stopping here.",
    "Tell me what you are trying to move and I will start from your own numbers.",
  ].join(" ");
}

export function browserObservedNote(): string {
  return "These numbers are what your screen was showing a moment ago, not a fresh pull from the account itself.";
}
