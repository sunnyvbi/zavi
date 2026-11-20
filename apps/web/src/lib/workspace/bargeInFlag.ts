export function isBargeInEnabled(): boolean {
  const v = process.env.NEXT_PUBLIC_AGENT_BARGE_IN;
  return v !== "0" && v !== "false";
}
