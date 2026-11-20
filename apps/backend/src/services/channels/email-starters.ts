export const EMAIL_STARTERS = ["Announce something new", "Win back people who went quiet", "Share a seasonal offer"] as const;

export function splitEmailStarter(brief: string): { starter: string | null; about: string } {
  const text = brief.trim();
  const starter = EMAIL_STARTERS.find((s) => text.startsWith(`${s}:`)) ?? null;
  if (!starter) return { starter: null, about: text };
  const about = text.slice(starter.length + 1).trim();
  return about ? { starter, about } : { starter: null, about: text };
}
