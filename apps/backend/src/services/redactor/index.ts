
export { redactValue, redactRow } from "../tools/operator-db/discovery/redact";
import { redactValue as redactValueImpl } from "../tools/operator-db/discovery/redact";

const DOB_NUMERIC =
  /\b(?:(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:19|20)\d{2}|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g;

const DOB_VERBAL =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(?:(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?)\s*,?\s+(?:19|20)\d{2}\b/gi;

const STREET_ADDRESS =
  /\b\d{1,6}\s+(?:[A-Z][a-z]+\.?\s+){1,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Court|Ct\.?|Place|Pl\.?|Terrace|Ter\.?|Plaza|Sq|Square|Circle|Cir\.?|Highway|Hwy\.?|Parkway|Pkwy\.?|Loop|Trail|Tr\.?)\b/g;

export function redactVoiceTranscript(text: string): string {
  if (!text) return text;
  return text
    .replace(DOB_NUMERIC, "‹redacted:dob›")
    .replace(DOB_VERBAL, "‹redacted:dob›")
    .replace(STREET_ADDRESS, "‹redacted:address›");
}

export function redactVoiceTranscriptFull(text: string): string {
  if (!text) return text;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { redactValue } = require("../tools/operator-db/discovery/redact") as {
    redactValue: (col: string, value: unknown) => unknown;
  };
  const standard = redactValue("voice_transcript", text);
  return typeof standard === "string"
    ? redactVoiceTranscript(standard)
    : String(standard);
}

export function redactAgentText(text: string): string {
  if (!text) return text;
  const out = redactValueImpl("agent_trace_text", text);
  return typeof out === "string" ? out : String(out);
}
