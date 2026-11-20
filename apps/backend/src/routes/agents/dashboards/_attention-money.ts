
const NON_MONEY_DECISION_CLASSES = new Set<string>([
  "operator.file-jira-issue",
  "operator.file-linear-issue",
  "operator.post-slack-message",
  "pm.needs_action",
]);

export function isMoneyOrAuthDecisionClass(decisionClass: string): boolean {
  return !NON_MONEY_DECISION_CLASSES.has(decisionClass);
}
