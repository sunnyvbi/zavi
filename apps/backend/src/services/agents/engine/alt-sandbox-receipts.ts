import { extractTestReceipt } from "@/agents/engineer/engineer-verify-receipt";
import { extractTypecheckReceipt } from "@/agents/engineer/typecheck-receipt";
import { extractReceipts } from "@/services/tools/receipt-extractor";
import type { ToolCallTrace } from "@/services/tools/types";
import type { EngineToolResult } from "./types";

export function attachAltSandboxReceipts(
  toolCalls: ToolCallTrace[],
  fullName: string,
  input: unknown,
  result: EngineToolResult,
): void {
  const trace = toolCalls[toolCalls.length - 1];
  if (!trace || trace.name !== fullName.slice(0, 64)) return;
  const isError = result.is_error === true;
  trace.test_receipt = extractTestReceipt(fullName, result.content, isError, input);
  trace.typecheck_receipt = extractTypecheckReceipt(fullName, result.content, isError, input);
  if (!isError) trace.receipts = extractReceipts(fullName, String(result.content ?? ""));
}
