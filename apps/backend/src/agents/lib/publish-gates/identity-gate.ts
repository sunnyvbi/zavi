
import { sentenceSpans } from "@/services/agents/attributed-figures";

const DISCLOSURE_MARKER = /\b(full disclosure|disclosure:|disclaimer:|for transparency)\b/i;

const FIRST_PERSON = /\b(i'm|i am|this is)\b/i;

const ROLE_WORD = /\b(run|runs|own|owns|founded|founder|owner|ceo|work at|work for|from)\b/i;

const BLAME = [
  /\bthat'?s on us\b/i,
  /\bour fault\b/i,
  /\bwe dropped the ball\b/i,
  /\bi'?ll personally look into\b/i,
  /\bwe'?ll make it right\b/i,
  /\bthat should(?:n'?t| not) have happened\b/i,
  /\bwe let you down\b/i,
];

const APOLOGY = /\b(sorry|apolog\w*)\b/i;
const COMPLAINT_TERM =
  /\b(complaint|bad experience|terrible experience|poor service|refund|dropped the ball|shit(?:ty)? (?:job|work|experience))\b/i;

const DISCLOSURE_WINDOW = 200;

export type IdentityEdit =
  | { rule: "named_person_disclosure" }
  | { rule: "blame_admission" };

export type IdentityResult = {
  content: string;
  edits: IdentityEdit[];
  hold?: "complaint_thread_unread";
};

const PERSON_NAME = /\b([A-Z][a-z'’-]{1,20}(?:\s+[A-Z][a-z'’-]{1,20}){1,2})\b/;

function mentionsCompany(sentence: string, companyNames: string[]): boolean {
  const s = sentence.toLowerCase();
  return companyNames.some((n) => n.length >= 3 && s.includes(n.toLowerCase()));
}

function rewriteDisclosure(
  content: string,
  companyNames: string[],
): { content: string; changed: boolean } {
  const spans = sentenceSpans(content);
  for (const sp of spans) {
    if (sp.start > DISCLOSURE_WINDOW) break;
    const sentence = content.slice(sp.start, sp.end);
    if (!ROLE_WORD.test(sentence)) continue;
    const role = ROLE_WORD.exec(sentence);
    if (!role) continue;
    const fp = FIRST_PERSON.exec(sentence);
    let firstPersonNearRole = false;
    if (fp) {
      const between = sentence.slice(
        Math.min(fp.index + fp[0].length, role.index + role[0].length),
        Math.max(fp.index, role.index),
      );
      firstPersonNearRole = between.split(/\s+/).filter(Boolean).length <= 6;
    }
    const markerWithRole = DISCLOSURE_MARKER.test(sentence);
    if (!firstPersonNearRole && !markerWithRole) continue;
    if (!mentionsCompany(sentence, companyNames) && !DISCLOSURE_MARKER.test(sentence)) continue;
    const withoutCompany = companyNames.reduce(
      (acc, n) => (n.length >= 3 ? acc.replace(new RegExp(escapeRe(n), "gi"), " ") : acc),
      sentence,
    );
    const named = PERSON_NAME.exec(stripLeadingI(withoutCompany));
    if (!named) continue;
    const company = companyNames[0];
    const replacement = company
      ? `Full disclosure, I work at ${company}.`
      : "Full disclosure, I work for the company behind this product.";
    const prefix = content.slice(0, sp.start);
    const suffix = content.slice(sp.end);
    return { content: `${prefix}${replacement}${suffix.startsWith(" ") ? "" : " "}${suffix}`.trimEnd(), changed: true };
  }
  return { content, changed: false };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingI(s: string): string {
  return s.replace(/\bI(?:'m| am)?\b/g, " ");
}

function removeBlame(content: string): { content: string; changed: boolean } {
  let out = content;
  let changed = false;
  for (let guard = 0; guard < 20; guard += 1) {
    const spans = sentenceSpans(out);
    const hit = spans.find((sp) => {
      const s = out.slice(sp.start, sp.end);
      return BLAME.some((re) => re.test(s));
    });
    if (!hit) break;
    out = `${out.slice(0, hit.start)}${out.slice(hit.end)}`.replace(/\n{3,}/g, "\n\n");
    changed = true;
  }
  return { content: changed ? out.replace(/[ \t]{2,}/g, " ").trim() : out, changed };
}

export function readsAsComplaintReply(content: string): boolean {
  if (BLAME.some((re) => re.test(content))) return true;
  return sentenceSpans(content).some((sp) => {
    const s = content.slice(sp.start, sp.end);
    return APOLOGY.test(s) && COMPLAINT_TERM.test(s) && /\b(you|your|yours)\b/i.test(s);
  });
}

export function applyIdentityGate(input: {
  content: string;
  companyNames: string[];
  isReply: boolean;
  threadUrl?: string;
  threadsRead: Set<string>;
}): IdentityResult {
  const edits: IdentityEdit[] = [];
  const disclosure = rewriteDisclosure(input.content, input.companyNames);
  if (disclosure.changed) edits.push({ rule: "named_person_disclosure" });
  const blame = removeBlame(disclosure.content);
  if (blame.changed) edits.push({ rule: "blame_admission" });

  const unreadThread =
    input.isReply && (!input.threadUrl || !input.threadsRead.has(input.threadUrl));
  if (unreadThread && readsAsComplaintReply(input.content)) {
    return { content: blame.content, edits, hold: "complaint_thread_unread" };
  }
  return { content: blame.content, edits };
}
