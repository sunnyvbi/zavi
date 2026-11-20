export function unwrapMcpContent(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const texts = raw
    .filter(
      (b): b is { type: "text"; text: string } =>
        !!b &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text);
  if (texts.length === 0) return raw;
  return texts.join("\n");
}
