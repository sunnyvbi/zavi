
export type StepStatus = "pending" | "done" | "skipped";
export type SetupDraftStatus = "none" | "running" | "failed" | "done";

export type SetupState = {
  enabled: true;
  docs: { status: StepStatus; files: number; facts: number };
  connectors: { status: StepStatus };
  done: boolean;
  home_seen: boolean;
  has_plan?: boolean;
  draft: { status: SetupDraftStatus; run_id: string | null; attempts: number; can_retry: boolean; free_retry: boolean };
  build_open?: boolean;
  coding_prompt_tucked?: boolean;
  one_state?: boolean;
  skip_no_confirm?: boolean;
  from_scratch?: boolean;
};

export type SetupResponse = SetupState | { enabled: false };

export type SetupMark =
  | { step: "docs" | "connectors"; outcome: "done" | "skipped" }
  | { step: "done" | "home" };
