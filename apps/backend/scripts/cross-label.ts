#!/usr/bin/env tsx

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAnthropic } from "@/services/anthropic";
import { goldenDirForSlug } from "@/services/agents/eval/golden-dir";

const JUDGE_MODEL = "claude-opus-4-7";
const EVAL_ROOT = join(__dirname, "..", "eval", "agent-faithfulness");
const VALID = new Set(["faithful", "partial", "hallucinated"]);

type Golden = {
  golden_id: string;
  input: string;
  actual_output: string;
  verdict: string | null;
  evidence_summary?: { evidence_note?: string; raw_tool_calls?: unknown };
};
type Verdict = { golden_id: string; verdict: string; reason?: string };

function args() {
  const a = { agent: "", lane: "", merge: false };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "--agent") a.agent = v[++i];
    else if (v[i] === "--lane") a.lane = v[++i];
    else if (v[i] === "--merge") a.merge = true;
  }
  return a;
}

function workDir(dir: string): string {
  const d = join(tmpdir(), "xlabel", dir);
  mkdirSync(d, { recursive: true });
  return d;
}

function blindCase(g: Golden) {
  const ev = g.evidence_summary ?? {};
  const evidence = ev.raw_tool_calls
    ? JSON.stringify(ev.raw_tool_calls).slice(0, 24000)
    : (ev.evidence_note ?? "(no evidence captured)");
  return { golden_id: g.golden_id, input: g.input, evidence, agent_output: g.actual_output };
}

function buildRubric(dir: string): string {
  let r = readFileSync(join(EVAL_ROOT, "faithfulness-judge-rubric.md"), "utf8");
  const layer = join(EVAL_ROOT, dir, "RUBRIC-LAYER.md");
  if (existsSync(layer)) r += "\n\n---\n\n" + readFileSync(layer, "utf8");
  return r;
}

function parseVerdicts(text: string): Verdict[] {
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s < 0 || e < 0) throw new Error(`no JSON array in lane output:\n${text.slice(0, 200)}`);
  return JSON.parse(text.slice(s, e + 1)) as Verdict[];
}

function loadGoldens(dir: string): Golden[] {
  return JSON.parse(readFileSync(join(EVAL_ROOT, dir, "goldens.json"), "utf8")) as Golden[];
}

async function laneClaude(dir: string, cases: ReturnType<typeof blindCase>[]): Promise<Verdict[]> {
  const resp = await getAnthropic().messages.create({
    model: JUDGE_MODEL,
    max_tokens: 4096,
    system: buildRubric(dir),
    messages: [
      {
        role: "user",
        content:
          "Label each run per the rubric. Return ONLY the JSON array, one object per item, in order:\n" +
          '[{"golden_id":"...","verdict":"faithful|partial|hallucinated","reason":"<one line>"}]\n\n' +
          JSON.stringify(cases),
      },
    ],
  });
  const block = resp.content.find((c) => c.type === "text");
  return parseVerdicts(block && block.type === "text" ? block.text : "");
}

async function main() {
  const a = args();
  if (!a.agent) {
    console.error("usage: cross-label.ts --agent <slug> [--lane claude | --merge]");
    process.exit(2);
  }
  const dir = goldenDirForSlug(a.agent);
  const wd = workDir(dir);
  const goldens = loadGoldens(dir);
  const cases = goldens.map(blindCase);

  if (a.merge) {
    const lanes: Record<string, Map<string, Verdict>> = {};
    for (const lane of ["claude", "codex", "grok"]) {
      const clean = join(wd, `${lane}.json`);
      const raw = join(wd, `${lane}-raw.txt`);
      const src = existsSync(clean) ? clean : raw;
      if (!existsSync(src)) {
        console.error(`missing lane output for ${lane} (looked for ${clean} / ${raw})`);
        process.exit(2);
      }
      const verds = parseVerdicts(readFileSync(src, "utf8"));
      lanes[lane] = new Map(verds.map((x) => [x.golden_id, x]));
    }

    const agreed: Array<{ id: string; verdict: string }> = [];
    const disputes: string[] = [];
    for (const g of goldens) {
      const vs = ["claude", "codex", "grok"].map((l) => {
        const x = lanes[l].get(g.golden_id);
        return { lane: l, verdict: x?.verdict ?? "?", reason: x?.reason ?? "" };
      });
      const valid = vs.filter((x) => VALID.has(x.verdict));
      const uniq = new Set(valid.map((x) => x.verdict));
      if (valid.length === 3 && uniq.size === 1) {
        agreed.push({ id: g.golden_id, verdict: valid[0].verdict });
      } else {
        disputes.push(
          `### ${g.golden_id}\n` +
            vs.map((x) => `- **${x.lane}**: ${x.verdict} — ${x.reason}`).join("\n"),
        );
      }
    }

    const now = new Date().toISOString();
    const byId = new Map(agreed.map((x) => [x.id, x.verdict]));
    for (const g of goldens) {
      const v = byId.get(g.golden_id);
      if (v) {
        (g as Golden & Record<string, unknown>).verdict = v;
        (g as Record<string, unknown>).labeled_by = "cross-family-3of3";
        (g as Record<string, unknown>).labeled_at = now;
      }
    }
    writeFileSync(join(EVAL_ROOT, dir, "goldens.json"), JSON.stringify(goldens, null, 2) + "\n");

    const report =
      `# Cross-family label disagreements — ${dir} (${now.slice(0, 10)})\n\n` +
      `3 families (Claude/Opus · Codex/OpenAI · Grok/xAI) labeled ${goldens.length} cards blind.\n` +
      `**Unanimous (3/3 → ground truth, written to goldens.json): ${agreed.length}/${goldens.length}.**\n` +
      `**Contested (need Ravi to settle): ${disputes.length}.**\n\n` +
      (disputes.length ? `## Settle these\n\n${disputes.join("\n\n")}\n` : "All unanimous — no human input needed.\n");
    writeFileSync(join(EVAL_ROOT, dir, "XLABEL-DISAGREEMENTS.md"), report);
    console.log(
      `${dir}: ${agreed.length}/${goldens.length} unanimous → goldens.json; ${disputes.length} contested → XLABEL-DISAGREEMENTS.md`,
    );
    return;
  }

  const verds = await laneClaude(dir, cases);
  writeFileSync(join(wd, "claude.json"), JSON.stringify(verds, null, 2));
  const prompt =
    buildRubric(dir) +
    "\n\n---\n\nLabel each run per the rubric above. Return ONLY the JSON array, one object per " +
    'item, in order: [{"golden_id":"...","verdict":"faithful|partial|hallucinated","reason":"<one line>"}]\n\n' +
    JSON.stringify(cases);
  writeFileSync(join(wd, "prompt.txt"), prompt);
  console.log(`claude lane: ${verds.length} verdicts → ${join(wd, "claude.json")}`);
  console.log(`prompt for codex/grok → ${join(wd, "prompt.txt")}`);
  console.log(`\nNow run the other two lanes, then --merge:`);
  console.log(`  codex exec "$(cat ${join(wd, "prompt.txt")})" -s read-only --skip-git-repo-check < /dev/null > ${join(wd, "codex-raw.txt")}`);
  console.log(`  ~/.claude/skills/super-engineer/lib/grok-call.sh exec ${join(wd, "prompt.txt")} > ${join(wd, "grok-raw.txt")}`);
  console.log(`  tsx -r tsconfig-paths/register scripts/cross-label.ts --agent ${a.agent} --merge`);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
