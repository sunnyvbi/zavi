
import type { DispatcherResult } from "@/services/agents/types";
import type { Digest } from "@/agents/chief-of-staff/output-schema";

const ADD_TOOL = "qa_engineer__add_test_case";

function isAddTestCaseTrace(name: string): boolean {
  return name === ADD_TOOL || name.endsWith(`__${ADD_TOOL}`);
}

export function countSeededFromTraces(result: DispatcherResult): number {
  let n = 0;
  for (const c of result.tool_calls ?? []) {
    if (c.status !== "ok") continue;
    if (isAddTestCaseTrace(c.name)) n += 1;
  }
  return n;
}

export function stampQaCatalogBuildCount(
  envelope: Digest,
  result: DispatcherResult,
): Digest {
  const cat = envelope.tier4?.[0]?.category;
  if (cat !== "qa-catalog-build") return envelope;
  const n = countSeededFromTraces(result);
  const tier4 = [...envelope.tier4];
  tier4[0] = {
    ...tier4[0],
    summary: `Seeded ${n} test case${n === 1 ? "" : "s"} from your company brain.`,
  };
  const body = envelope.rendered_markdown ?? "";
  const header = `qa seeded **${n}** test case${n === 1 ? "" : "s"} from your company brain.`;
  return {
    ...envelope,
    tier4,
    rendered_markdown: `${header}\n\n${stripLeadingCountLine(body)}`,
  };
}

function stripLeadingCountLine(md: string): string {
  return md.replace(/^\s*qa[^\n]*test case[^\n]*\n+/i, "");
}
