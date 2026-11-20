
import { selectRenderedText } from "../render-select";
import {
  codeSideAutonomy,
  type BehaviorGolden,
} from "./behavior-goldens";

export type ScoredBehaviorCase = {
  name: string;
  kind: BehaviorGolden["kind"];
  incident?: string;
  pass: boolean;
  reason?: string;
};

export type BehaviorScoreReport = {
  total: number;
  passed: number;
  accuracy: number;
  cases: ScoredBehaviorCase[];
  incidentFailures: ScoredBehaviorCase[];
};

function scoreOne(g: BehaviorGolden): string | null {
  switch (g.kind) {
    case "money_move": {
      const got = codeSideAutonomy(g.input.server_id, g.input.tool_name);
      if (got !== g.expect.autonomy) {
        return `expected autonomy=${g.expect.autonomy}, got ${got}`;
      }
      if (g.money_or_write && got === "auto") {
        return `money/write action resolved to AUTO — must require approval`;
      }
      return null;
    }
    case "envelope": {
      const sel = selectRenderedText({
        envelope: g.input.envelope,
        agentSlug: g.input.agentSlug,
        parsed: g.input.parsed,
        rawText: g.input.rawText,
      });
      const text = sel.text ?? "";
      if (g.expect.nonEmpty && text.trim().length === 0) {
        return `render seam returned EMPTY text (blank bubble)`;
      }
      for (const needle of g.expect.contains ?? []) {
        if (!text.includes(needle)) {
          return `expected text to contain ${JSON.stringify(needle)} — got ${JSON.stringify(text.slice(0, 120))}`;
        }
      }
      for (const banned of g.expect.excludes ?? []) {
        if (text.includes(banned)) {
          return `text must NOT contain ${JSON.stringify(banned)} (leak/placeholder) — got ${JSON.stringify(text.slice(0, 120))}`;
        }
      }
      if (g.expect.rescueKind !== undefined) {
        const gotKind = sel.rescueKind ?? null;
        if (gotKind !== g.expect.rescueKind) {
          return `expected rescueKind=${g.expect.rescueKind}, got ${gotKind}`;
        }
      }
      return null;
    }
    default: {
      const _never: never = g;
      return `unknown behavior golden kind: ${JSON.stringify(_never)}`;
    }
  }
}

export function scoreBehavior(goldens: BehaviorGolden[]): BehaviorScoreReport {
  const cases: ScoredBehaviorCase[] = goldens.map((g) => {
    const reason = scoreOne(g);
    return {
      name: g.name,
      kind: g.kind,
      incident: g.incident,
      pass: reason === null,
      reason: reason ?? undefined,
    };
  });
  const passed = cases.filter((c) => c.pass).length;
  return {
    total: cases.length,
    passed,
    accuracy: cases.length ? passed / cases.length : 0,
    cases,
    incidentFailures: cases.filter((c) => c.incident && !c.pass),
  };
}
