
export function isStreamTokensEnabled(): boolean {
  return process.env.NEXT_PUBLIC_STREAM_TOKENS_ENABLED !== "false";
}
