
import { z } from "zod";

export const researchEvalTaskSchema = z.object({
  task_id: z.string().min(1),
  agent_slug: z.literal("research"),
  ask: z.string().min(1),
  notes: z.string().min(1),
});
export type ResearchEvalTask = z.infer<typeof researchEvalTaskSchema>;

export const researchTasksFileSchema = z.array(researchEvalTaskSchema).min(1);

export type ResearchRubricScores = {
  source_independence: number;
  recency: number;
  primary_vs_secondary: number;
  so_what: number;
  fact_vs_judgment: number;
};

export type ResearchRubricResult = {
  task_id: string;
  scores: ResearchRubricScores;
  justification: string;
  error?: string;
};

export type ResearchTaskOutcome = {
  task: ResearchEvalTask;
  rubric: ResearchRubricResult;
  rendered_preview: string;
  run_error?: string;
};

export type ResearchEvalReport = {
  ts: string;
  total: number;
  run_errors: number;
  scored: number;
  mean_rubric: ResearchRubricScores | null;
  baseline: ResearchRubricScores | null;
  passed_baseline: boolean;
  outcomes: ResearchTaskOutcome[];
};
