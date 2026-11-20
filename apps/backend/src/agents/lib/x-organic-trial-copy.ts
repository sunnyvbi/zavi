import { xPostText } from "@/services/connectors/x-ads/schema";

export function xOrganicTrialCopyIssue(d: { kind: string; content: string; parts?: Array<{ content: string }> }): string | null {
  if (d.kind !== "post" || d.parts?.length !== 3) return "An organic trial needs exactly three standalone post parts.";
  const texts = d.parts.map(p => p.content);
  if (new Set(texts.map(t => t.replace(/\s+/g, " ").trim())).size !== 3) return "Use three different posts.";
  if (texts.some(t => !xPostText.safeParse(t).success)) return "Each organic post must be complete and within X's 280-character limit.";
  if (/[\[{][^\]}]*[A-Za-z][^\]}]*[\]}]|_{3,}/.test([d.content, ...texts].join("\n"))) return "Finish the organic posts without template blanks or future ad inputs.";
  return null;
}
