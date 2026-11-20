
const RECALL_RE =
  /\b(last (week|month|time|night|year)|the other day|(\d+|a few|several|couple) (days?|weeks?|months?) ago|earlier (you|we|today)|you (opened|created|made|built|shipped|ran|sent)|the pr you|that (task|report|run|pr|build|analysis|thing you)|what (were|was) the (params|parameters|settings|numbers|inputs)|remember when|previously|a while ago|back (in|on|when)|from (last|earlier|yesterday)|yesterday)\b/i;

export function detectRecallIntent(text: string): boolean {
  return typeof text === "string" && text.length > 0 && RECALL_RE.test(text);
}

export const RECALL_PROMPT_RULE =
  "RECALL: this message refers to a PAST task or run (e.g. \"last week\", \"that report\", \"the PR you opened\"). Before answering, find the SPECIFIC prior run with your run-history tools: `praxis_corpus__query_recent_runs` lists recent runs (filter by agent_slug), then `praxis_corpus__read_run_output` reads the one you need. Report its agent, parameters, result, and any PR/link. Ground your answer in what you actually find. If you cannot locate it, say so plainly and ask a clarifying detail — do NOT invent params, dates, or results.";
