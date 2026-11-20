
export function mapClaudeJsonToDispatcherResult(cliJson, opts = {}) {
  const j = cliJson ?? {};
  const status = opts.status;
  const u = j.usage ?? {};

  const parse_ok =
    status !== "failed" && j.is_error === false && j.subtype === "success";

  const output_text = typeof j.result === "string" ? j.result : "";

  const result = {
    output_text,
    raw_response_text: output_text,
    parse_ok,
    parsed: null,
    prompt_snapshot: typeof opts.promptSnapshot === "string" ? opts.promptSnapshot : "",
    stop_reason:
      j.subtype === "success" ? "end_turn"
      : j.subtype === "error_max_turns" ? "max_tokens"
      : j.subtype === "error_during_execution" ? "error"
      : (typeof j.stop_reason === "string" ? j.stop_reason : (j.is_error ? "error" : "end_turn")),
    usage: {
      input_tokens: Number(u.input_tokens ?? 0),
      output_tokens: Number(u.output_tokens ?? 0),
    },
  };

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  if (u.cache_creation_input_tokens != null) {
    const v = num(u.cache_creation_input_tokens);
    if (v !== undefined) result.usage.cache_creation_input_tokens = v;
  }
  if (u.cache_read_input_tokens != null) {
    const v = num(u.cache_read_input_tokens);
    if (v !== undefined) result.usage.cache_read_input_tokens = v;
  }
  if (j.total_cost_usd != null) {
    const v = num(j.total_cost_usd);
    if (v !== undefined) result.usage.cost_usd = v;
  }

  if (!parse_ok) {
    result.parse_error =
      j.subtype && j.subtype !== "success" ? `subtype=${j.subtype}`
      : (output_text ? output_text.slice(0, 2000) : "local run failed");
  }

  const lp = opts.localPr;
  if (
    lp &&
    typeof lp === "object" &&
    Number.isInteger(lp.pr_number) &&
    lp.pr_number > 0 &&
    typeof lp.pr_url === "string" &&
    typeof lp.pr_repo === "string" &&
    typeof lp.head_branch === "string"
  ) {
    result.local_pr = {
      pr_number: lp.pr_number,
      pr_url: lp.pr_url,
      pr_repo: lp.pr_repo,
      head_branch: lp.head_branch,
    };
  }

  return result;
}
