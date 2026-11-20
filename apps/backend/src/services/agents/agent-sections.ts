
export function splitAgentSection(
  body: string,
  heading: string,
): { section: string; rest: string } | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  return {
    section: lines.slice(start, end).join("\n").trim(),
    rest: [...lines.slice(0, start), ...lines.slice(end)].join("\n"),
  };
}
