
const BARE_DUMP_KEYS = "stat_tiles|rows|tiles|bars|persona_cards";

export function stripLeakedJson(md: string): string {
  let out = md
    .replace(/```[ \t]*json\b(?:(?!```)[\s\S])*?```/gi, "")
    .replace(/```[ \t]*\r?\n[ \t]*[{[](?:(?!```)[\s\S])*?```/g, "")
    .replace(
      new RegExp(
        `^[ \\t]*(?:[-*][ \\t]+)?\\*{0,2}\\s*(?:${BARE_DUMP_KEYS})\\s*\\*{0,2}\\s*:\\s*\\*{0,2}\\s*\\[\\s*\\{[\\s\\S]*?\\}\\s*\\]`,
        "gim",
      ),
      "",
    );
  const trimmed = out.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      out = "";
    } catch {
    }
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
