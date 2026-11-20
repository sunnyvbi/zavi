
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { EvalReport, EvalCaseResult } from "./types";

const BEHAVIOR_ROOT = path.resolve(__dirname, "../../../eval/agent-behavior");
const DIMENSIONS = ["task-success", "connector-wall", "format"] as const;

const OUTPUT_DERIVABLE = new Set([
  "connect-action-marker",
  "connector-wall-phrasing",
  "empty-output",
  "raw-error-as-output",
  "control-plane-leak",
  "action-claim-with-zero-tool-calls",
]);

const VALID_STATUS = new Set(["gold", "candidate"]);
const VALID_SOURCE = new Set(["deterministic", "dual_llm", "third_family", "human"]);

type GoldenRow = {
  golden_id?: string;
  agent_slug?: string;
  dimension?: string;
  verdict?: string;
  status?: string;
  label_source?: string;
  actual_output?: string;
  detector?: { rule?: string; matched?: string[] };
};

type Detector = (c: {
  actual_output: string;
  evidence_summary?: { tool_count: number };
}) => { verdict: string; rule: string } | null;

type DetectorModule = { DETECTORS: Record<string, Detector> };

export async function scoreAgentBehaviorGoldens(): Promise<EvalReport> {
  const ts = new Date().toISOString();
  const base: Omit<EvalReport, "total" | "passed" | "failed" | "accuracy" | "failures"> = {
    slug: "agent-behavior-detector-stability",
    ts,
    blocking_gate: true,
  };
  try {
    const detectorUrl = pathToFileURL(path.join(BEHAVIOR_ROOT, "_BUILD/detectors.mjs")).href;
    const { DETECTORS } = (await import(detectorUrl)) as DetectorModule;

    const failures: EvalCaseResult[] = [];
    let total = 0;

    for (const dim of DIMENSIONS) {
      const dimDir = path.join(BEHAVIOR_ROOT, dim);
      if (!fs.existsSync(dimDir)) continue;
      for (const agent of fs.readdirSync(dimDir)) {
        const file = path.join(dimDir, agent, "goldens.json");
        if (!fs.existsSync(file)) continue;
        let rows: GoldenRow[];
        try {
          rows = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          total++;
          failures.push({ case_id: `${dim}/${agent}`, pass: false, reason: "invalid JSON" });
          continue;
        }
        for (const g of rows) {
          total++;
          const id = g.golden_id ?? `${dim}/${agent}/?`;
          const shapeErr =
            g.dimension !== dim
              ? `dimension ${g.dimension} != ${dim}`
              : !g.golden_id
                ? "missing golden_id"
                : !g.verdict
                  ? "missing verdict"
                  : !VALID_STATUS.has(g.status ?? "")
                    ? `bad status ${g.status}`
                    : !VALID_SOURCE.has(g.label_source ?? "")
                      ? `bad label_source ${g.label_source}`
                      : null;
          if (shapeErr) {
            failures.push({ case_id: id, pass: false, reason: shapeErr });
            continue;
          }
          const rule = g.detector?.rule ?? "";
          if (OUTPUT_DERIVABLE.has(rule)) {
            const out = g.actual_output ?? "";
            const matched = g.detector?.matched?.[0] ?? "";
            const signalPresent = !matched || out.includes(matched.slice(0, 40));
            if (signalPresent) {
              const c =
                rule === "action-claim-with-zero-tool-calls"
                  ? { actual_output: out, evidence_summary: { tool_count: 0 } }
                  : { actual_output: out };
              const r = DETECTORS[dim]?.(c);
              if (!r || r.verdict !== g.verdict) {
                failures.push({
                  case_id: id,
                  pass: false,
                  reason: `detector re-run gave ${r ? r.verdict : "null"} but golden stores ${g.verdict} (rule ${rule})`,
                  meta: { dim, rule },
                });
              }
            }
          }
        }
      }
    }

    const failed = failures.length;
    const passed = total - failed;
    return {
      ...base,
      total,
      passed,
      failed,
      accuracy: total ? passed / total : 1,
      failures: failures.slice(0, 50),
      notes: `${total} behavior goldens checked (shape + output-derivable detector determinism). Deterministic, zero LLM.`,
    };
  } catch (e) {
    return {
      ...base,
      total: 0,
      passed: 0,
      failed: 1,
      accuracy: 0,
      failures: [{ case_id: "loader", pass: false, reason: `eval errored: ${(e as Error).message}` }],
      notes: "agent-behavior gate failed to load — see failure reason.",
    };
  }
}
