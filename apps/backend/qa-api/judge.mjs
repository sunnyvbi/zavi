
const JUDGE_MODEL = "claude-haiku-4-5-20251001";

const IN_PER_MTOK = 1.0;
const OUT_PER_MTOK = 5.0;

export async function judge(env, { rubric, content }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { pass: false, reason: "judge unavailable: ANTHROPIC_API_KEY missing in .env", costUsd: 0 };
  }
  const snippet = typeof content === "string" ? content : JSON.stringify(content ?? null);
  const system =
    "You are a strict-but-fair QA judge for an API regression suite. You are told a " +
    "behavioral RUBRIC and given the actual captured RESULT from a live agent/LLM endpoint. " +
    "Decide ONLY whether the result satisfies the rubric's BEHAVIOR — not its exact wording. " +
    "A coherent, on-task, non-empty, non-error result that meets the rubric PASSES even if " +
    "phrased differently than expected. An error, empty body, truncated/garbage output, a " +
    "generic placeholder, or a result that contradicts the rubric FAILS. " +
    "Note: a ship-gate/critic that correctly HOLDS or REFUSES is a PASS when the rubric asks " +
    "for that behavior — a refusal is not a failure. " +
    'Reply with ONLY compact JSON: {"pass":true|false,"reason":"<=20 words"}.';
  const user = `RUBRIC (the behavior that must hold):\n${rubric}\n\nACTUAL RESULT (captured from the endpoint):\n${snippet.slice(0, 12000)}`;

  let r, body;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 200,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    body = await r.json();
  } catch (e) {
    return { pass: false, reason: `judge call errored: ${String(e).slice(0, 80)}`, costUsd: 0 };
  }
  if (!r.ok) {
    return { pass: false, reason: `judge HTTP ${r.status}: ${JSON.stringify(body).slice(0, 120)}`, costUsd: 0 };
  }
  const usage = body.usage || {};
  const costUsd =
    ((usage.input_tokens || 0) / 1e6) * IN_PER_MTOK + ((usage.output_tokens || 0) / 1e6) * OUT_PER_MTOK;
  const text = (body.content || []).map((b) => b.text || "").join("").trim();
  const verdict = parseVerdict(text);
  return { ...verdict, costUsd };
}

function parseVerdict(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      return { pass: !!o.pass, reason: String(o.reason || "").slice(0, 160) };
    } catch {
    }
  }
  return { pass: /\bpass\b|\btrue\b|\byes\b/i.test(text) && !/\bfail|false|no\b/i.test(text), reason: `unparseable judge reply: ${text.slice(0, 80)}` };
}
