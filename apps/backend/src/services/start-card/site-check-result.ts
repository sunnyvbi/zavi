
import {
  START_CARD_CHECK_KEYS,
  type StartCardCheckKey,
  type StartCardGoogleEvidence,
  type StartCardParts,
  type StartCardScore,
} from "@zavi/shared";
import { webBaseUrl } from "@/services/web-base";
import type { StartCardRow } from "./store";

export const CHECK_LABELS: Record<StartCardCheckKey, string> = {
  google: "Found on Google",
  ai: "Shows up in AI answers",
  seo: "SEO & site basics",
  design: "Design & UX",
  compare: "Vs your competitors",
};

export function cardUrl(publicId: string): string {
  return `${webBaseUrl()}/r/${publicId}`;
}

export type CheckScore = { check: StartCardCheckKey; label: string; points: number | null; max: number };

export function scoresOf(score: StartCardScore | null | undefined): CheckScore[] {
  return START_CARD_CHECK_KEYS.map((k) => ({
    check: k,
    label: CHECK_LABELS[k],
    points: score?.by_check?.[k] ?? null,
    max: 20,
  }));
}

export function googleEvidenceOf(parts: StartCardParts | null | undefined): StartCardGoogleEvidence | null {
  const g = parts?.google;
  return g?.state === "done" && g.evidence ? (g.evidence as StartCardGoogleEvidence) : null;
}

export function scoredSearchTerm(row: Pick<StartCardRow, "search_term"> & { parts?: StartCardParts | null }): string | null {
  return googleEvidenceOf(row.parts)?.search_term || row.search_term;
}

export function composeFounderResult(
  row: Pick<StartCardRow, "domain" | "public_id" | "status" | "score" | "search_term"> & { parts?: StartCardParts | null },
): string {
  const link = cardUrl(row.public_id);
  if (row.status !== "done" || !row.score) {
    return (
      `The site check for ${row.domain} couldn't finish, so it wasn't charged. ` +
      `You can ask me to run it again, or open ${link}.`
    );
  }
  const lines = [`Your site check for ${row.domain} is done: ${row.score.total} out of ${row.score.out_of}.`];
  const google = googleEvidenceOf(row.parts);
  if (google?.note) lines.push(google.note);
  else if (row.search_term) lines.push(`Search term we checked: "${row.search_term}".`);
  for (const s of scoresOf(row.score)) {
    lines.push(`• ${s.label}: ${s.points === null ? "couldn't measure" : `${s.points}/${s.max}`}`);
  }
  lines.push(`Full card: ${link}`);
  return lines.join("\n");
}
