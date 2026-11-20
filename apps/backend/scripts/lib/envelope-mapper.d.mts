
export interface ClaudeCliJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  stop_reason?: unknown;
  total_cost_usd?: number | string;
  usage?: {
    input_tokens?: number | string;
    output_tokens?: number | string;
    cache_creation_input_tokens?: number | string;
    cache_read_input_tokens?: number | string;
  };
  [key: string]: unknown;
}

export interface MapOpts {
  status?: "done" | "failed";
  promptSnapshot?: string;
  localPr?: unknown;
}

export interface LocalPr {
  pr_number: number;
  pr_url: string;
  pr_repo: string;
  head_branch: string;
}

export interface MappedDispatcherResult {
  output_text: string;
  raw_response_text: string;
  parse_ok: boolean;
  parsed: null;
  prompt_snapshot: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cost_usd?: number;
  };
  parse_error?: string;
  local_pr?: LocalPr;
}

export function mapClaudeJsonToDispatcherResult(
  cliJson: ClaudeCliJson | null | undefined,
  opts?: MapOpts,
): MappedDispatcherResult;
