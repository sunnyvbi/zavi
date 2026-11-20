
const CRITIC_NOTE_PREFIXES = [
  "- Code review flagged a blocking issue",
  "- The change may not fully match the request",
  "- Adversarial code review could not run this time",
];

const OTHER_NOTE_OPENINGS = [
  "- Tests: ",
  "- Tests prove nothing: ",
  "- Typecheck (",
  "- Typecheck: ",
  "- Runtime route check (",
  "- Wiring: ",
  "- Committed dist: ",
  "- Diagnosis: ",
  "- Carried constant: ",
];

const SECTION_HEADING = "## Testing & verification";
const SECTION_INTRO = "_Automated checks that did not fully pass or could not run in the sandbox.";

function isNoteOpening(line: string): boolean {
  return (
    CRITIC_NOTE_PREFIXES.some((p) => line.startsWith(p)) ||
    OTHER_NOTE_OPENINGS.some((p) => line.startsWith(p))
  );
}

export function stripLegacyCriticNotes(body: string): string {
  if (typeof body !== "string" || !CRITIC_NOTE_PREFIXES.some((p) => body.includes(p))) {
    return body;
  }
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(eol);

  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === SECTION_HEADING && (lines[i + 2] ?? "").startsWith(SECTION_INTRO)) {
      start = i;
      break;
    }
  }
  if (start < 0) return body;

  const notesStart = lines.findIndex((l, i) => i > start + 2 && isNoteOpening(l));
  if (notesStart < 0) return body;
  const notes: string[][] = [];
  for (let i = notesStart; i < lines.length; i++) {
    if (isNoteOpening(lines[i])) notes.push([lines[i]]);
    else notes[notes.length - 1].push(lines[i]);
  }
  const keptNotes = notes.filter((n) => !CRITIC_NOTE_PREFIXES.some((p) => n[0].startsWith(p)));
  if (keptNotes.length === notes.length) return body;

  const before = lines.slice(0, start);
  let section: string[] = [];
  if (keptNotes.length > 0) {
    section = [...lines.slice(start, notesStart), ...keptNotes.flat()];
    while (section.length > 0 && section[section.length - 1].trim() === "") section.pop();
  } else {
    while (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
  }
  return [...before, ...section].join(eol);
}
