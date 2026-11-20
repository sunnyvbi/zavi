export function extractQuestionText(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  for (const k of [
    "current_user_text_raw",
    "current_message",
    "task_description",
    "question",
    "prompt",
    "user_text",
    "message",
  ]) {
    const v = p[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const slack = p.slack;
  if (slack && typeof slack === "object") {
    const text = (slack as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim().length > 0) return text;
  }
  const teams = p.teams;
  if (teams && typeof teams === "object") {
    const text = (teams as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim().length > 0) return text;
  }
  const so = p.standing_order;
  if (so && typeof so === "object") {
    const sop = (so as Record<string, unknown>).prompt;
    if (typeof sop === "string" && sop.length > 0) return sop;
  }
  return "";
}
