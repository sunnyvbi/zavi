#!/usr/bin/env tsx

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAnthropic } from "@/services/anthropic";
import { goldenDirForSlug } from "@/services/agents/eval/golden-dir";

const JUDGE_MODEL = "claude-opus-4-7";
const EVAL_ROOT = join(__dirname, "..", "eval", "agent-faithfulness");
const LEVEL: Record<string, number> = { faithful: 0, partial: 1, hallucinated: 2 };

type Golden = {
  golden_id: string;
  input: string;
  actual_output: string;
  verdict: string | null;
  evidence_summary?: { evidence_note?: string; raw_tool_calls?: unknown };
};
type JudgeOut = { golden_id: string; verdict: string; reason?: string };

function parseArgs(argv: string[]) {
  const a = { agent: "", mock: false, write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") a.agent = argv[++i];
    else if (argv[i] === "--mock") a.mock = true;
    else if (argv[i] === "--write") a.write = true;
  }
  return a;
}

function blindInput(g: Golden) {
  const ev = g.evidence_summary ?? {};
  const evidence = ev.raw_tool_calls
    ? JSON.stringify(ev.raw_tool_calls).slice(0, 24000)
    : (ev.evidence_note ?? "(no evidence captured)");
  return { golden_id: g.golden_id, input: g.input, evidence, agent_output: g.actual_output };
}

async function runJudge(rubric: string, items: ReturnType<typeof blindInput>[]): Promise<JudgeOut[]> {
  const resp = await getAnthropic().messages.create({
    model: JUDGE_MODEL,
    max_tokens: 4096,
    system: rubric,
    messages: [
      {
        role: "user",
        content:
          "Judge each of these runs per the rubric. Return ONLY the JSON array, one object per item, in order.\n\n" +
          JSON.stringify(items),
      },
    ],
  });
  const block = resp.content.find((c) => c.type === "text");
  const text = block && block.type === "text" ? block.text : "";
  const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end < 0) throw new Error(`judge returned no JSON array:\n${text.slice(0, 300)}`);
  return JSON.parse(cleaned.slice(start, end + 1)) as JudgeOut[];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.agent) {
    console.error("usage: judge-cal.ts --agent <slug-or-dir> [--mock] [--write]");
    process.exit(2);
  }
  const dir = goldenDirForSlug(args.agent);
  const goldensPath = join(EVAL_ROOT, dir, "goldens.json");
  if (!existsSync(goldensPath)) {
    console.error(`no goldens.json at ${goldensPath} (resolved '${args.agent}' -> '${dir}')`);
    process.exit(2);
  }
  const all = JSON.parse(readFileSync(goldensPath, "utf8")) as Golden[];
  const labeled = all.filter((g) => g.verdict && LEVEL[g.verdict] !== undefined);
  if (labeled.length === 0) {
    console.error(`${dir}: 0 labeled goldens — label them before calibrating.`);
    process.exit(2);
  }

  const items = labeled.map(blindInput);
  let judged: JudgeOut[];
  if (args.mock) {
    judged = labeled.map((g) => ({ golden_id: g.golden_id, verdict: g.verdict as string, reason: "mock" }));
  } else {
    let rubric = readFileSync(join(EVAL_ROOT, "faithfulness-judge-rubric.md"), "utf8");
    const layerPath = join(EVAL_ROOT, dir, "RUBRIC-LAYER.md");
    if (existsSync(layerPath)) {
      rubric += "\n\n---\n\n" + readFileSync(layerPath, "utf8");
      console.log(`(applied per-agent rubric layer: ${dir}/RUBRIC-LAYER.md)`);
    }
    judged = await runJudge(rubric, items);
  }

  const byId = new Map(judged.map((j) => [j.golden_id, j.verdict]));
  let exact = 0,
    within1 = 0,
    twoLevel = 0;
  const misses: string[] = [];
  for (const g of labeled) {
    const jv = byId.get(g.golden_id);
    if (!jv || LEVEL[jv] === undefined) {
      misses.push(`${g.golden_id}: judge gave no/unknown verdict (${jv})`);
      continue;
    }
    const diff = Math.abs(LEVEL[g.verdict as string] - LEVEL[jv]);
    if (diff === 0) exact++;
    if (diff <= 1) within1++;
    if (diff === 2) {
      twoLevel++;
      misses.push(`${g.golden_id}: human=${g.verdict} judge=${jv} (2-LEVEL ERROR)`);
    } else if (diff === 1) {
      misses.push(`${g.golden_id}: human=${g.verdict} judge=${jv}`);
    }
  }
  const n = labeled.length;
  const exactPct = (exact / n) * 100;
  const pass = Math.round(exactPct) >= 87 && twoLevel === 0;

  const report =
    `# judge calibration — ${dir} (${new Date().toISOString().slice(0, 10)})\n\n` +
    `Judge: ${JUDGE_MODEL} (blind) vs ${n} Ravi labels.\n\n` +
    `| metric | value |\n|---|---|\n` +
    `| exact-match | ${exact}/${n} (${exactPct.toFixed(0)}%) |\n` +
    `| within-1 | ${within1}/${n} |\n` +
    `| 2-level errors | ${twoLevel} |\n` +
    `| GATE (≥87% exact + 0 two-level) | ${pass ? "PASS ✅" : "FAIL ❌"} |\n\n` +
    (misses.length ? `## Misses\n${misses.map((m) => `- ${m}`).join("\n")}\n` : "All exact.\n");

  console.log(report);
  console.log(pass ? `CALIBRATED: ${dir} may be added to GROUNDING_GATE_AGENTS.` : `NOT CALIBRATED: ${dir} judge disagrees too much — tighten rubric or re-check labels.`);

  if (args.write && !args.mock) {
    writeFileSync(join(EVAL_ROOT, dir, "CALIBRATION.md"), report);
    console.log(`wrote ${dir}/CALIBRATION.md`);
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
