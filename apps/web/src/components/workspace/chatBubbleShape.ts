
export type BubbleRenderShape = "plain-text" | "markdown" | "system-italic";

export function bubbleRenderShape(
  role: "user" | "assistant" | "system",
): BubbleRenderShape {
  if (role === "user") return "plain-text";
  if (role === "system") return "system-italic";
  return "markdown";
}
