
export type OpenRole = {
  slug: string;
  title: string;
  team: string;
  location: string;
  type: string;
  compensation?: string;
  summary: string;
  whatYoullDo: string[];
  lookingFor: string[];
};

export const APPLY_EMAIL = "careers@zaviagent.com";

export const OPEN_ROLES: OpenRole[] = [];

export function applyHref(role: OpenRole): string {
  const subject = encodeURIComponent(`Application: ${role.title}`);
  const body = encodeURIComponent(
    [
      `Hi Zavi team,`,
      ``,
      `I'd like to apply for ${role.title}.`,
      ``,
      `Why I'm a fit:`,
      ``,
      `Links (GitHub / portfolio / LinkedIn):`,
      ``,
      `Resume attached.`,
      ``,
    ].join("\n"),
  );
  return `mailto:${APPLY_EMAIL}?subject=${subject}&body=${body}`;
}

export function generalApplyHref(): string {
  const subject = encodeURIComponent("Open application");
  return `mailto:${APPLY_EMAIL}?subject=${subject}`;
}
