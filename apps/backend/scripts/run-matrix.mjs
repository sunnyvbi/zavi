
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist/src/services");
const CORPUS_JS = path.join(DIST, "eval/engine-parity/agent-corpus.js");
const MAP_JS = path.join(DIST, "eval/engine-parity/agent-model-map.js");
const ENGINE_JS = path.join(DIST, "agents/engine/openai-engine.js");
const SO_JS = path.join(DIST, "agents/structured-output.js");
const MODELS_JS = path.join(DIST, "llm/models.js");

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf("--only");
const onlyAgent = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const taskIdx = argv.indexOf("--task");
const onlyTask = taskIdx >= 0 ? argv[taskIdx + 1] : null;
const provIdx = argv.indexOf("--provider");
const PROVIDER = provIdx >= 0 ? argv[provIdx + 1] : "openai";
if (PROVIDER !== "openai" && PROVIDER !== "bedrock") {
  console.error(`[run-matrix] --provider must be openai|bedrock (got '${PROVIDER}').`);
  process.exit(2);
}

const OUT = process.env.MATRIX_OUT || "/tmp/claude-501/matrix-openai-outputs.json";
const MAX_TURNS = 3;

if (PROVIDER === "openai" && !process.env.OPENAI_API_KEY) {
  console.error(
    "[run-matrix] OPENAI_API_KEY is not set — this script fires REAL OpenAI calls.\n" +
      "Set OPENAI_API_KEY to run the matrix. (Refusing to run without it.)",
  );
  process.exit(2);
}
if (PROVIDER === "bedrock" && !(process.env.BEDROCK_OPENAI_BASE_URL && process.env.AWS_BEARER_TOKEN_BEDROCK)) {
  console.error(
    "[run-matrix] --provider bedrock needs BEDROCK_OPENAI_BASE_URL + AWS_BEARER_TOKEN_BEDROCK.\n" +
      "e.g. BEDROCK_OPENAI_BASE_URL=https://bedrock-mantle.us-west-2.api.aws/v1 (Refusing to run without them.)",
  );
  process.exit(2);
}

let corpusMod, mapMod, engineMod, soMod, modelsMod;
try {
  corpusMod = await import(CORPUS_JS);
  mapMod = await import(MAP_JS);
  engineMod = await import(ENGINE_JS);
  soMod = await import(SO_JS);
  modelsMod = await import(MODELS_JS);
} catch (e) {
  console.error(
    `\n[run-matrix] could not load compiled dist from:\n  ${DIST}\n` +
      `Run \`npm run build\` in apps/backend first.\n` +
      `Underlying error: ${e?.message || e}\n`,
  );
  process.exit(2);
}

const { AGENT_CORPUS } = corpusMod;
const { rolefitModel } = mapMod;
const { OpenAIAgentEngine, BedrockOpenAICompatAgentEngine } = engineMod;
const { toOutputFormatJsonSchema, AGENT_OUTPUT_CLASS } = soMod;
const { MODELS } = modelsMod;

const makeEngine = () =>
  PROVIDER === "bedrock" ? new BedrockOpenAICompatAgentEngine() : new OpenAIAgentEngine();
const modelFor = (slug) =>
  PROVIDER === "bedrock" ? MODELS.bedrock.qwen3Next80b : rolefitModel(slug);

let tasks = AGENT_CORPUS;
if (onlyAgent) tasks = tasks.filter((t) => t.agent_slug === onlyAgent);
if (onlyTask) tasks = tasks.filter((t) => t.task_id === onlyTask);
if (tasks.length === 0) {
  console.error(`[run-matrix] no tasks match filter (only=${onlyAgent} task=${onlyTask}).`);
  process.exit(2);
}

console.error(
  `[run-matrix] running ${tasks.length} task(s) through the REAL OpenAIAgentEngine.\n` +
    `[run-matrix] out=${OUT}`,
);

function schemaForSlug(slug) {
  if (!AGENT_OUTPUT_CLASS[slug]) return null;
  try {
    return toOutputFormatJsonSchema(slug);
  } catch {
    return null;
  }
}

function extractRenderedMarkdown(text, structured) {
  if (!structured) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.rendered_markdown === "string") {
      return parsed.rendered_markdown;
    }
    return text;
  } catch {
    return text;
  }
}

async function runOne(task) {
  const model = modelFor(task.agent_slug);
  const outputJsonSchema = schemaForSlug(task.agent_slug);
  const events = [];
  const spec = {
    systemPrompt: task.system,
    userPrompt: task.prompt,
    model,
    maxTurns: MAX_TURNS,
    tools: [],
    resume: null,
    abort: new AbortController(),
    dispatchTool: async () => ({ is_error: false, content: "", ms: 0 }),
    onEvent: (e) => events.push(e),
    ...(outputJsonSchema ? { outputJsonSchema } : {}),
  };

  let errored = false;
  let error_detail;
  try {
    for await (const _ of makeEngine().run(spec)) void _;
  } catch (e) {
    errored = true;
    error_detail = e?.message?.slice(0, 300) || e?.name || "Error";
  }

  const rawText = events
    .filter((e) => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  const openai_output = extractRenderedMarkdown(rawText, !!outputJsonSchema);

  return {
    task_id: task.task_id,
    agent_slug: task.agent_slug,
    model,
    prompt: task.prompt,
    system: task.system,
    openai_output,
    errored,
    ...(error_detail ? { error_detail } : {}),
  };
}

const results = [];
let i = 0;
for (const task of tasks) {
  i += 1;
  const model = modelFor(task.agent_slug);
  process.stderr.write(`[run-matrix] (${i}/${tasks.length}) ${task.task_id} → ${model} ... `);
  const t0 = Date.now();
  const res = await runOne(task);
  const ms = Date.now() - t0;
  process.stderr.write(
    res.errored
      ? `ERROR (${res.error_detail}) ${ms}ms\n`
      : `ok ${res.openai_output.length}ch ${ms}ms\n`,
  );
  results.push(res);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
const errs = results.filter((r) => r.errored).length;
console.error(
  `[run-matrix] DONE. ${results.length} task(s), ${errs} errored. Wrote ${OUT}`,
);
