
import { getAnthropic, hasAnthropicAuth, DEFAULT_MODEL } from "@/services/anthropic";
import { execFileSync } from "node:child_process";

export const JUDGE_LABELER_ALLOWED_TENANTS = new Set<string>([
  "73db45ff-457e-4541-bc8f-bdb625390204",
]);

export type Candidate = { note_id: string; title: string; body: string };

export type JudgeVote = {
  family: string;
  picked_note_ids: string[];
  error?: string;
};

export type LabelResult = {
  expected_note_ids: string[];
  agreement: number;
  votes: JudgeVote[];
  families_voted: number;
  low_confidence: boolean;
};

export type Judge = (query: string, candidates: Candidate[]) => Promise<string[]>;

export type CalibrationVerdict = "strong" | "weak" | "disagree";
export function classifyCalibration(judgeExpected: string[], anchorExpected: string[]): CalibrationVerdict {
  if (judgeExpected.length === 0 || anchorExpected.length === 0) return "disagree";
  const judged = new Set(judgeExpected);
  const anchor = new Set(anchorExpected);
  const overlap = [...anchor].filter((id) => judged.has(id));
  if (overlap.length === 0) return "disagree";
  const exact = judged.size === anchor.size && [...anchor].every((id) => judged.has(id));
  return exact ? "strong" : "weak";
}

const MAX_BODY_CHARS = 1200;
const MAX_CANDIDATES = 12;

function buildPrompt(query: string, candidates: Candidate[]): string {
  const lines = candidates
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => `[${i + 1}] ${c.title}\n${(c.body || "").slice(0, MAX_BODY_CHARS)}`)
    .join("\n\n");
  return `A user asked an internal agent this question:\n\n"${query}"\n\nHere are candidate memory notes. Pick the number(s) of EVERY note that DIRECTLY answers the question — typically 1-3. Many questions are answered by SEVERAL notes together (e.g. a fact plus its context); include ALL of them, not just the single best. Return an empty list ONLY if no note answers it.\n\n${lines}\n\nRespond with ONLY a JSON object: {"best": [<numbers>]}. No prose.`;
}

export function extractQuestionText(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const hasLetters = (t: string) => /[a-zA-Z]/.test(t);
  const usable = (t: string) => hasLetters(t) && !t.startsWith("{") && !t.startsWith("[");
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s) as { current_message?: unknown };
      const cm = obj?.current_message;
      const text =
        typeof cm === "string"
          ? cm
          : cm && typeof (cm as { text?: unknown }).text === "string"
            ? (cm as { text: string }).text
            : null;
      const t = text?.trim();
      return t && usable(t) ? t : null;
    } catch {
      return null;
    }
  }
  return hasLetters(s) ? s : null;
}

export function parseJudgeReply(raw: string, candidates: Candidate[]): string[] {
  const m = raw.match(/\{[^}]*"best"[^}]*\}/s);
  if (!m) return [];
  let nums: unknown;
  try {
    nums = (JSON.parse(m[0]) as { best?: unknown }).best;
  } catch {
    return [];
  }
  if (!Array.isArray(nums)) return [];
  const out: string[] = [];
  for (const n of nums) {
    const idx = typeof n === "number" ? n : parseInt(String(n), 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= Math.min(candidates.length, MAX_CANDIDATES)) {
      out.push(candidates[idx - 1].note_id);
    }
  }
  return Array.from(new Set(out));
}

async function claudeJudge(query: string, candidates: Candidate[]): Promise<string[]> {
  const res = await getAnthropic().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 128,
    messages: [{ role: "user", content: buildPrompt(query, candidates) }],
  });
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  return parseJudgeReply(text, candidates);
}

const CODEX_BIN = process.env.PRAXIS_JUDGE_CODEX_BIN || "codex";
const CODEX_TIMEOUT_MS = 90_000;

function codexAvailable(): boolean {
  try {
    execFileSync("which", [CODEX_BIN], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CODEX_ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "SHELL", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
function codexChildEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const k of CODEX_ENV_ALLOW) if (process.env[k] !== undefined) e[k] = process.env[k];
  return e;
}

async function codexJudge(query: string, candidates: Candidate[]): Promise<string[]> {
  const prompt = buildPrompt(query, candidates);
  let out: string;
  try {
    out = execFileSync(CODEX_BIN, ["exec", "--skip-git-repo-check", "-s", "read-only", prompt], {
      encoding: "utf8",
      timeout: CODEX_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
      env: codexChildEnv(),
    });
  } catch (e) {
    const partial = (e as { stdout?: Buffer | string }).stdout;
    const tail = (typeof partial === "string" ? partial : partial?.toString() ?? "").slice(-120);
    throw new Error(`codex judge failed (${(e as Error).message?.slice(0, 100)})${tail ? ` partial:${tail}` : ""}`);
  }
  return parseJudgeReply(out, candidates);
}

export function getAvailableJudges(): Array<{ family: string; judge: Judge }> {
  const judges: Array<{ family: string; judge: Judge }> = [];
  if (hasAnthropicAuth()) judges.push({ family: "claude", judge: claudeJudge });
  if (codexAvailable()) judges.push({ family: "openai", judge: codexJudge });
  return judges;
}

export async function labelQuery(
  query: string,
  candidates: Candidate[],
  judges: Array<{ family: string; judge: Judge }>,
): Promise<LabelResult> {
  const votes: JudgeVote[] = await Promise.all(
    judges.map(async ({ family, judge }): Promise<JudgeVote> => {
      try {
        const picked = await judge(query, candidates);
        return { family, picked_note_ids: picked };
      } catch (e) {
        return { family, picked_note_ids: [], error: (e as Error)?.message?.slice(0, 200) ?? "judge error" };
      }
    }),
  );
  const voted = votes.filter((v) => !v.error);
  const familiesVoted = voted.length;

  const tally = new Map<string, number>();
  for (const v of voted) {
    for (const id of v.picked_note_ids) tally.set(id, (tally.get(id) ?? 0) + 1);
  }
  const maxVotes = tally.size > 0 ? Math.max(...tally.values()) : 0;
  const majority = Math.floor(familiesVoted / 2) + 1;
  const expected = [...tally.entries()].filter(([, c]) => c >= majority).map(([id]) => id);
  const agreement = familiesVoted > 0 ? maxVotes / familiesVoted : 0;

  return {
    expected_note_ids: expected,
    agreement: Number(agreement.toFixed(4)),
    votes,
    families_voted: familiesVoted,
    low_confidence: agreement < 1 || familiesVoted < 2,
  };
}
