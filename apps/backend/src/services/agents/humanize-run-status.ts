
export function humanizeRunStatus(status: string): string {
  switch (status) {
    case "parse_failed":
      return "incomplete output";
    case "dispatch_error":
      return "didn't run";
    case "failed":
      return "errored";
    case "paused_awaiting_child":
      return "waiting on another agent";
    default:
      return status;
  }
}
