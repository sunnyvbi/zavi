
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(
  __dirname,
  "../dist/services/eval/engine-parity/engine-parity.js",
);

let harness;
try {
  harness = await import(HARNESS);
} catch (e) {
  console.error(
    `\n[engine-parity] could not load the compiled harness at:\n  ${HARNESS}\n` +
      `Run \`npm run build\` in apps/backend first (the typed harness must be compiled to dist).\n` +
      `Underlying error: ${e?.message || e}\n`,
  );
  process.exit(2);
}

const {
  REPRESENTATIVE_TASKS,
  runParitySuite,
  formatParityReport,
} = harness;

const argv = process.argv.slice(2);
const wantLive = argv.includes("--live");
const noJudge = argv.includes("--no-judge");

const hasAnthropic =
  !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!hasAnthropic) {
  console.error(
    "[engine-parity] No Anthropic auth (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN). The Claude lane needs it.",
  );
  process.exit(2);
}

const hasOpenAi = !!process.env.OPENAI_API_KEY;
const openaiLive = wantLive && hasOpenAi;
const openaiSkipReason = !wantLive
  ? "OpenAI lane gated: pass --live to enable"
  : "OpenAI lane gated: OPENAI_API_KEY not set";

const anthropic = new Anthropic();
const ANTHROPIC_MODEL = "claude-opus-4-7";
const OPENAI_MODEL = process.env.PRAXIS_PARITY_OPENAI_MODEL || "gpt-5.5";
const MAX_TOKENS = 700;

let openai = null;
async function getOpenAi() {
  if (openai) return openai;
  const { default: OpenAI } = await import("openai");
  openai = new OpenAI();
  return openai;
}

function normalizeUsage(raw, provider) {
  const num = (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const zero = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  if (!raw || typeof raw !== "object") return zero;
  if (provider === "openai") {
    const cached = num(raw.prompt_tokens_details?.cached_tokens);
    return {
      input_tokens: Math.max(0, num(raw.prompt_tokens) - cached),
      output_tokens: num(raw.completion_tokens),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    };
  }
  return {
    input_tokens: num(raw.input_tokens),
    output_tokens: num(raw.output_tokens),
    cache_read_input_tokens: num(raw.cache_read_input_tokens),
    cache_creation_input_tokens: num(raw.cache_creation_input_tokens),
  };
}

async function runTask(task, provider) {
  const t0 = Date.now();
  if (provider === "anthropic") {
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system: task.system,
      messages: [{ role: "user", content: task.prompt }],
    });
    const output = (resp.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return {
      output,
      latency_ms: Date.now() - t0,
      usage: normalizeUsage(resp.usage, "anthropic"),
      model: ANTHROPIC_MODEL,
      gated_tool_calls: 0,
      errored: false,
    };
  }
  const client = await getOpenAi();
  const resp = await client.chat.completions.create({
    model: OPENAI_MODEL,
    max_completion_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: task.system },
      { role: "user", content: task.prompt },
    ],
  });
  const output = resp.choices?.[0]?.message?.content ?? "";
  return {
    output,
    latency_ms: Date.now() - t0,
    usage: normalizeUsage(resp.usage, "openai"),
    model: OPENAI_MODEL,
    gated_tool_calls: 0,
    errored: false,
  };
}

const JUDGE_MODEL = "claude-haiku-4-5-20251001";
async function judge(prompt) {
  const resp = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 400,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });
  return (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

console.error(
  `[engine-parity] tasks=${REPRESENTATIVE_TASKS.length}  anthropic=ON  ` +
    `openai=${openaiLive ? "ON" : `SKIP (${openaiSkipReason})`}  ` +
    `judge=${noJudge ? "OFF" : "ON"}`,
);

const report = await runParitySuite(REPRESENTATIVE_TASKS, {
  runTask,
  openaiLive,
  openaiSkipReason,
  judge: noJudge ? undefined : judge,
});

console.log(formatParityReport(report));
