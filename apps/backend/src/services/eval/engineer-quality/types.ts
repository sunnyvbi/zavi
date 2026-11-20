
import { z } from "zod";

export const taskSchema = z.object({
  task_id: z.string().min(1),
  agent_slug: z.literal("engineer"),
  bucket: z.enum(["bug-fix", "bug-fix-money", "small-feature"]),
  source: z.string().min(1),
  prompt: z.string().min(1),
  fixture_file: z.string().min(1),
  test_file: z.string().min(1),
  pass_check: z.string().min(1),
  expected_touch: z.array(z.string().min(1)).min(1),
  known_good_reference: z.string().min(1),
});
export type EvalTask = z.infer<typeof taskSchema>;

export const tasksFileSchema = z.array(taskSchema).min(1);

export const realRepoTaskSchema = z.object({
  task_id: z.string().min(1),
  agent_slug: z.literal("engineer"),
  bucket: z.enum(["bug-fix", "bug-fix-money", "small-feature"]),
  source: z.string().min(1),
  prompt: z.string().min(1),
  base_sha: z.string().min(7),
  head_sha: z.string().min(7),
  oracle_test_files: z.array(z.string().min(1)).min(1),
  expected_touch: z.array(z.string().min(1)).min(1),
  known_good_reference: z.string().min(1),
});
export type RealRepoTask = z.infer<typeof realRepoTaskSchema>;

export const realRepoTasksFileSchema = z.array(realRepoTaskSchema).min(1);

export type RealRepoCandidate = RealRepoTask & {
  changed_src_files: string[];
  changed_lines: number;
  red_at_base: boolean;
  green_at_head: boolean;
};

export type SuiteName = "fixture" | "real-repo" | "hard";

export type ProducedFileChange = {
  path: string;
  action: "create" | "modify" | "delete";
  content?: string;
};

export type DriverErrorKind = "ok" | "transient" | "max_turns";

export type ProducedDiff = {
  task_id: string;
  files: ProducedFileChange[];
  error_kind?: DriverErrorKind;
  attempts?: number;
  error_detail?: string;
};

export type DeterministicResult = {
  task_id: string;
  tests_green: boolean;
  typecheck_ok: boolean | null;
  touched: string[];
  out_of_scope: string[];
  output_tail: string;
  error?: string;
  failure_kind: "infra" | "nofix" | null;
  attempts?: number;
  error_detail?: string;
};

export type RubricScores = {
  correctness: number;
  scope_fit: number;
  regression_safety: number;
};

export type RubricResult = {
  task_id: string;
  scores: RubricScores;
  justification: string;
  error?: string;
};

export type TaskOutcome = {
  task: EvalTask;
  deterministic: DeterministicResult;
  rubric: RubricResult | null;
};

export type EvalReport = {
  ts: string;
  total: number;
  infra_errors: number;
  scored: number;
  merge_equivalent_pct: number;
  mean_rubric: RubricScores | null;
  outcomes: TaskOutcome[];
};
