
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist/src/services/eval/engine-parity");
const HARNESS = path.join(DIST, "engine-parity.js");
const LIVE_RUNNER = path.join(DIST, "live-runner.js");

let harness, liveRunner;
try {
  harness = await import(HARNESS);
  liveRunner = await import(LIVE_RUNNER);
} catch (e) {
  console.error(
    `\n[engine-parity-live] could not load the compiled harness/runner from:\n  ${DIST}\n` +
      `Run \`npm run build\` in apps/backend first.\n` +
      `Underlying error: ${e?.message || e}\n`,
  );
  process.exit(2);
}

const { REPRESENTATIVE_TASKS, runParitySuite, formatParityReport } = harness;
const { makeLiveRunTask } = liveRunner;

const argv = process.argv.slice(2);
const wantLive = argv.includes("--live");
const noJudge = argv.includes("--no-judge");

const hasAnthropic =
  !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!hasAnthropic) {
  console.error(
    "[engine-parity-live] No Anthropic auth (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN). The Claude baseline lane needs it.",
  );
  process.exit(2);
}

const hasOpenAi = !!process.env.OPENAI_API_KEY;
const openaiLive = wantLive && hasOpenAi;
const openaiSkipReason = !wantLive
  ? "OpenAI lane gated: pass --live to enable the REAL OpenAIAgentEngine lane"
  : "OpenAI lane gated: OPENAI_API_KEY not set";

const runTask = makeLiveRunTask();

let judge;
if (!noJudge) {
  const { callModel } = await import(
    path.resolve(__dirname, "../dist/src/services/llm/call-model.js")
  );
  const JUDGE_MODEL = "claude-haiku-4-5-20251001";
  judge = async (prompt) => {
    const res = await callModel({
      provider: "anthropic",
      model: JUDGE_MODEL,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      max_tokens: 400,
    });
    return res.text;
  };
}

console.error(
  `[engine-parity-live] tasks=${REPRESENTATIVE_TASKS.length}  anthropic(baseline)=ON  ` +
    `openai(REAL engine)=${openaiLive ? "ON" : `SKIP (${openaiSkipReason})`}  ` +
    `judge=${noJudge ? "OFF" : "ON"}`,
);

const report = await runParitySuite(REPRESENTATIVE_TASKS, {
  runTask,
  openaiLive,
  openaiSkipReason,
  judge,
});

console.log(formatParityReport(report));
