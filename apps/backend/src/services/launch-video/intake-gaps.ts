
import { z } from "zod";

const FIELD_HELP: Record<string, string> = {
  audience: "who the video is for, in the customer's own words",
  url: "the customer's product URL (the one they gave you or the one recorded on their account)",
  cta_url: "where the closing call-to-action should send viewers",
  product_name: "the customer's product name",
  one_liner: "the single line the video opens on",
  problem: "the problem the product solves, stated the way the customer states it",
  video_type: "one of the supported video types (ad / launch / promo / testimonial / explainer)",
  platform: "where this will be posted",
};

function fieldLabel(path: (string | number)[]): string {
  return path.length > 0 ? path.map(String).join(".") : "(root)";
}

export function describeIntakeGaps(e: unknown): string {
  if (!(e instanceof z.ZodError)) {
    return `The video request couldn't be read: ${(e as Error)?.message ?? String(e)}.`;
  }
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const issue of e.issues) {
    const label = fieldLabel(issue.path as (string | number)[]);
    const isMissing =
      issue.code === "invalid_type" &&
      ((issue as { received?: string }).received === "undefined" ||
        /received undefined/i.test(issue.message));
    const help = FIELD_HELP[label];
    const rendered = help ? `\`${label}\` (${help})` : `\`${label}\``;
    if (isMissing) missing.push(rendered);
    else invalid.push(`${rendered}: ${issue.message}`);
  }
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`I still need ${missing.length === 1 ? "one thing" : `${missing.length} things`}: ${missing.join(", ")}.`);
  }
  if (invalid.length > 0) {
    parts.push(`These are present but not usable: ${invalid.join("; ")}.`);
  }
  if (parts.length === 0) parts.push("The video request is incomplete.");
  return parts.join(" ");
}
