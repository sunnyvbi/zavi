import { capExecResult } from "../../sandbox/tool-registry";
import { extractSignals } from "./signals";

export type CapProfile = "engineer" | "default";

export type SignalRecall = {
  recall: number;
  fullSignals: string[];
  survived: string[];
  dropped: string[];
};

export type ScoreInput = {
  raw: string;
  capBytes: number;
  capProfile: CapProfile;
  nonZeroExit?: boolean;
};

function cappedCorpus(input: ScoreInput): string {
  const prev = process.env.SANDBOX_EXEC_OUTPUT_CAPS;
  process.env.SANDBOX_EXEC_OUTPUT_CAPS = "1";
  try {
    const r = {
      stdout: input.raw,
      stderr: "",
      exit_code: input.nonZeroExit ? 1 : 0,
      ms: 0,
    };
    const payload = capExecResult(r, input.capBytes, input.capProfile);
    const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
    const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
    const errors = Array.isArray(payload._errors) ? payload._errors.join("\n") : "";
    return [stdout, stderr, errors].join("\n");
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_EXEC_OUTPUT_CAPS;
    else process.env.SANDBOX_EXEC_OUTPUT_CAPS = prev;
  }
}

export function scoreSignalRecall(input: ScoreInput): SignalRecall {
  const fullSignals = extractSignals(input.raw);
  const corpus = cappedCorpus(input);
  const survived: string[] = [];
  const dropped: string[] = [];
  for (const sig of fullSignals) {
    if (corpus.includes(sig)) survived.push(sig);
    else dropped.push(sig);
  }
  const recall = fullSignals.length === 0 ? 1 : survived.length / fullSignals.length;
  return { recall, fullSignals, survived, dropped };
}
