import { callModel, type CallModelOpts, type CallModelResult } from "@/services/llm/call-model";
import { claudeOneShot } from "@/services/llm/claude-oneshot";

const REFUSED = /\b(429|rate_limit|rate limit|overloaded|401|403|authentication|permission)\b/i;

export async function callRedditModel(opts: CallModelOpts): Promise<CallModelResult> {
  try {
    return await callModel(opts);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (opts.provider !== "anthropic" || !REFUSED.test(msg)) throw err;
    console.warn(`[reddit-llm] callModel refused (${msg.slice(0, 80)}); retrying through the claude binary`);
    const user = opts.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n\n");
    const r = await claudeOneShot({
      model: opts.model,
      system: opts.system ?? "",
      user,
      timeoutMs: Math.max(opts.timeoutMs ?? 30_000, 120_000),
    });
    return {
      text: r.text,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      provider: "anthropic",
    };
  }
}
