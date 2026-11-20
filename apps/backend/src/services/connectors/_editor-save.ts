
export type EditorStagedChange = {
  label: string;
  decision_id: string;
  approved: boolean;
  code: string | null;
};

export type PlannedEditorChange = {
  decision_class: string;
  body: Record<string, unknown>;
  label: string;
};

export class EditorPartialSaveError extends Error {
  constructor(
    readonly landed: EditorStagedChange[],
    readonly failed_label: string,
    readonly not_sent: string[],
    readonly failure: unknown,
  ) {
    super(`partial save: ${landed.length} staged, "${failed_label}" failed`);
    this.name = "EditorPartialSaveError";
  }
}

export async function applyPlannedChanges(
  planned: PlannedEditorChange[],
  stage: (p: PlannedEditorChange) => Promise<EditorStagedChange>,
): Promise<EditorStagedChange[]> {
  const out: EditorStagedChange[] = [];
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i]!;
    try {
      out.push(await stage(p));
    } catch (e) {
      if (out.length === 0) throw e;
      throw new EditorPartialSaveError(out, p.label, planned.slice(i + 1).map((x) => x.label), e);
    }
  }
  return out;
}

export function partialSaveMessage(e: EditorPartialSaveError, why: string): string {
  const landed = e.landed
    .map((c) => `"${c.label}" (${c.approved ? "on its way" : "waiting in Approvals"})`)
    .join(", ");
  const code = (e.failure as { code?: unknown } | null)?.code;
  const unconfirmed = typeof code === "string" && code.endsWith("_stage_unknown");
  const notSaved = (unconfirmed ? e.not_sent : [e.failed_label, ...e.not_sent]).map((l) => `"${l}"`).join(", ");
  const reason = why.replace(/\s*Nothing (new )?was (saved|sent)[^.]*\.?/gi, "").trim();
  return `${reason ? `${reason.replace(/\.?$/, ".")} ` : ""}Saved: ${landed}.${notSaved ? ` Not saved: ${notSaved}.` : ""}`;
}
