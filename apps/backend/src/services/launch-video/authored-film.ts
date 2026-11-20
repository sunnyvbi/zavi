
import ts from "typescript";
import { getAnthropic, DEFAULT_MODEL } from "@/services/anthropic";

export type AuthorFilmInput = {
  intake: Record<string, unknown>;
  targetFrames: number;
  technique: string;
  exemplar: string;
  grammar?: "dense" | "calm";
};

const GRAMMAR_BRIEF: Record<"dense" | "calm", string> = {
  dense: [
    "GRAMMAR: DENSE-FAST. This film is for someone evaluating how the product works, and it",
    "should read as competent, informed and busy.",
    "  - 20 to 30 cuts. Shots run 2.0 to 2.5 seconds, never past 3.4.",
    "  - Every shot 60 to 85 percent full, carrying 8 or more values a viewer can read.",
    "  - DENSE ON ARRIVAL: in a shot this short there is no room to stagger an entrance, so",
    "    nothing may arrive later than frame 10. Everything lands inside ~8 frames, 1 to 2",
    "    frames apart, and the rest of the shot is spent MOVING, not arriving.",
    "  - Do NOT thin a shot to make it fast. Emptying the frame is the wrong fix for a short",
    "    beat; arriving sooner is the right one.",
    "  - USE THE WHOLE FRAME. A headline across the top with nothing under it wastes the bottom",
    "    40 percent of a 1080 frame. Every shot owes a SECOND REGISTER beneath or beside the",
    "    first: the thing itself, a list, a receipt, a panel, a row of real values. Not",
    "    decoration, not a divider, something a viewer can read.",
    "  - THE SECOND REGISTER IS BUILT FROM MATERIAL YOU WERE GIVEN, NEVER INVENTED. If the",
    "    product has no numbers, the frame gets NO numbers: no percentages, no progress bars,",
    "    no meters, no counts. Restating a rule as `100%` is a fabricated statistic and is",
    "    worse than an empty half. When there is nothing true left to add, make the type and",
    "    the subject BIGGER and let them own the frame. Filling space never outranks grounding.",
  ].join("\n"),
  calm: [
    "GRAMMAR: CALM-CONTINUOUS. This film is for someone deciding whether they want the product",
    "at all, and it should read as calm, confident and human.",
    "  - TWO TO FOUR CUTS IN THE ENTIRE FILM. It is a continuous flow: things slide, morph and",
    "    drift between states rather than being cut between. If you are writing a tenth",
    "    Series.Sequence you are writing the other grammar.",
    "  - Set-pieces hold 15 to 25 seconds each, carrying their length with internal motion.",
    "  - Open around 25 percent full and fill toward 80 by the end. Three quarters of an early",
    "    frame being empty is correct, not a mistake to fix.",
    "  - One to three values on screen at a time. Enormous type, four or five words at a time.",
    "  - Show ONE concrete task a person recognises in a second, not a metric moving. A school",
    "    email, a shopping cart with a price on it, a delayed flight. Never a dashboard, never",
    "    a chart, never a channel list.",
    "  - A SET-PIECE THAT STOPS MOVING IS A STALL. Holding 20 seconds is only earned if",
    "    something is still changing in EVERY frame of it: the thing being used, a value",
    "    updating, the camera easing, the scene becoming the next one. A held still with one",
    "    line of type arriving 8 seconds in is the failure this grammar is most prone to.",
    "  - Sparse EARLY, never sparse LATE. Opening at a quarter full is correct; still being a",
    "    quarter full at the end is not. By the last third the frame carries its subject and a",
    "    second readable register, and the bottom 40 percent is doing work.",
  ].join("\n"),
};

export type AuthorFilmResult =
  | { ok: true; tsx: string }
  | { ok: false; error: string };

export type Completer = (system: string, user: string) => Promise<string>;

const defaultComplete: Completer = async (system, user) => {
  const anthropic = getAnthropic();
  const resp = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = resp.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
};

export function extractTsx(raw: string): string | null {
  const fenced = raw.match(/```(?:tsx?|typescript|jsx|javascript)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw) ?? "";
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ALLOWED_IMPORTS = new Set(["react", "remotion"]);

const FORBIDDEN: Array<{ pattern: RegExp; why: string; commentsExempt?: boolean; stringsBlanked?: boolean }> = [
  { pattern: /\bfetch\s*\(/, why: "network access" },
  { pattern: /\bXMLHttpRequest\b/, why: "network access" },
  { pattern: /\bWebSocket\b/, why: "network access" },
  { pattern: /\brequire\s*\(/, why: "dynamic require" },
  { pattern: /\bimport\s*\(/, why: "dynamic import" },
  { pattern: /\beval\s*\(/, why: "eval" },
  { pattern: /new\s+Function\s*\(/, why: "function constructor" },
  { pattern: /\bprocess\s*\./, why: "process access" },
  { pattern: /\b(child_process|node:fs|node:net|node:http)\b/, why: "node builtins" },
  { pattern: /\\u[0-9a-fA-F]{4}/, why: "escaped identifier", stringsBlanked: true },
  { pattern: /\\u\{[0-9a-fA-F]+\}/, why: "escaped identifier", stringsBlanked: true },
  { pattern: /\\x[0-9a-fA-F]{2}/, why: "escaped identifier", stringsBlanked: true },
  { pattern: /\bsendBeacon\b/, why: "network access" },
  { pattern: /\bnavigator\b/, why: "navigator access" },
  { pattern: /\bnew\s+Image\s*\(/, why: "image loader" },
  { pattern: /\bimportScripts\b/, why: "network access" },
  { pattern: /\bEventSource\b/, why: "network access" },
  { pattern: /\bnew\s+Audio\s*\(/, why: "audio loader" },
  { pattern: /\burl\s*\(\s*['"]?\s*(?:https?:|\/\/)/i, why: "css url" },
  { pattern: /@import\b/i, why: "css import" },
  { pattern: /\bcreateElement\s*\(/, why: "createElement" },
  { pattern: /\bdangerouslySetInnerHTML\b/, why: "raw html" },
  { pattern: /\[\s*['"`][^'"`]+['"`]\s*\]\s*\(/, why: "string-indexed call" },
  { pattern: /\{\s*\.\.\.\s*\{/, why: "inline-object spread" },
  { pattern: /https?:\/\/[^\s"')]+\.(png|jpe?g|gif|webp|svg|mp4|webm)/i, why: "remote media" },
  { pattern: /[—―]/, why: "em dash in on-screen copy", commentsExempt: true },
];

export type FilmCheck = { ok: true } | { ok: false; error: string };

export function checkAuthoredFilm(tsx: string, targetFrames: number): FilmCheck {
  if (tsx.length < 400) return { ok: false, error: "film_too_short" };
  if (tsx.length > 120_000) return { ok: false, error: "film_too_large" };

  if (!/export\s+const\s+AuthoredFilm\b/.test(tsx)) return { ok: false, error: "missing_AuthoredFilm_export" };
  const framesDecls = [...tsx.matchAll(/export\s+const\s+AUTHORED_FRAMES\s*(?::\s*number\s*)?=\s*(\d+)/g)];
  if (framesDecls.length === 0) return { ok: false, error: "missing_AUTHORED_FRAMES_export" };
  if (framesDecls.length > 1) return { ok: false, error: "ambiguous_AUTHORED_FRAMES_export" };
  const allBindings = [...tsx.matchAll(/\b(?:const|let|var)\s+AUTHORED_FRAMES\b/g)];
  if (allBindings.length !== 1) return { ok: false, error: "ambiguous_AUTHORED_FRAMES_export" };
  const framesDecl = framesDecls[0]!;

  const declared = Number(framesDecl[1]);
  if (declared !== targetFrames) return { ok: false, error: `frame_count_mismatch:${declared}!=${targetFrames}` };

  const stringsBlanked = tsx.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[0]);

  const codeOnly = tsx
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile("film.tsx", tsx, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch (e) {
    return { ok: false, error: `unparsable_film:${(e as Error).constructor.name}` };
  }

  const parseErrors = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (Array.isArray(parseErrors) && parseErrors.length > 0) {
    return { ok: false, error: `unparsable_film:${parseErrors.length}` };
  }

  let bad: string | null = null;
  const check = (spec: ts.Node | undefined, kind: string): void => {
    if (bad) return;
    if (!spec || !ts.isStringLiteral(spec)) {
      bad = `forbidden_import:<computed ${kind}>`;
      return;
    }
    if (!ALLOWED_IMPORTS.has(spec.text)) bad = `forbidden_import:${spec.text.slice(0, 40)}`;
  };
  const stack: ts.Node[] = [sourceFile];
  while (stack.length > 0 && !bad) {
    const node = stack.pop()!;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) check(node.moduleSpecifier, "specifier");
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      check(ts.isExternalModuleReference(ref) ? ref.expression : undefined, "import-equals");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isDynamicImport || isRequire) {
        check(node.arguments[0], isDynamicImport ? "dynamic import" : "require");
      }
    }
    if (!bad) ts.forEachChild(node, (child) => void stack.push(child));
  }
  if (bad) return { ok: false, error: bad };

  for (const f of FORBIDDEN) {
    const subject = f.stringsBlanked ? stringsBlanked : f.commentsExempt ? codeOnly : tsx;
    if (f.pattern.test(subject)) return { ok: false, error: `forbidden:${f.why}` };
  }

  const RESOLVABLE_ATTR = "src|href|srcSet|poster|action|data|xlinkHref|xlink:href|formAction|cite|background|codeBase|longDesc|manifest|profile|usemap";
  for (const attr of tsx.matchAll(new RegExp(`<[A-Za-z][^>]*?\\s(${RESOLVABLE_ATTR})\\s*=\\s*\\{([^}]*)\\}`, "gs"))) {
    const expr = (attr[2] ?? "").trim();
    if (/^staticFile\s*\(\s*(['"`])[^'"`]*\1\s*\)$/.test(expr)) continue;
    return { ok: false, error: `forbidden:computed ${attr[1]} attribute` };
  }
  for (const attr of tsx.matchAll(new RegExp(`<[A-Za-z][^>]*?\\s(${RESOLVABLE_ATTR})\\s*=\\s*["']([^"']*)["']`, "gs"))) {
    const value = attr[2] ?? "";
    if (/^data:/i.test(value)) continue;
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value)) {
      return { ok: false, error: `forbidden:absolute ${attr[1]} url` };
    }
  }
  if (/\b(globalThis|window|document|self)\s*\[/.test(tsx)) {
    return { ok: false, error: "forbidden:computed global access" };
  }

  return { ok: true };
}

const SYSTEM = [
  "You write a single Remotion component: a complete, silent, 1920x1080 launch film for one product.",
  "Output ONLY the file, in one ```tsx fenced block. No prose before or after.",
  "",
  "HARD REQUIREMENTS, a film that misses any of these is discarded:",
  "  - Export `AUTHORED_FRAMES` (a number literal) and `AuthoredFilm` (a component taking NO props).",
  "  - Import ONLY from 'react' and 'remotion'. Nothing else exists in the sandbox.",
  "  - No network, no fetch, no remote images, no process or filesystem access. Draw everything.",
  "  - No em dash anywhere in on-screen copy. Use a full stop or a comma.",
  "  - The film is SILENT. On-screen text is the only channel, so let a viewer read.",
  "",
  "GROUNDING: write the copy yourself, in your own words, so it fits the shots you design.",
  "But every NUMBER, currency amount, percentage, place, company, person and rating must come",
  "from the intake below. Do not invent a statistic, a customer, a logo or a market you were",
  "not given. If the intake has no numbers, write a film with no numbers in it.",
].join("\n");

export async function authorFilm(
  input: AuthorFilmInput,
  deps: { complete?: Completer } = {},
): Promise<AuthorFilmResult> {
  const complete = deps.complete ?? defaultComplete;
  const user = [
    "TECHNIQUE BRIEF — follow every rule in it:",
    input.technique,
    "",
    "WORKED EXAMPLE — imitate its STRUCTURE (shot table with frame offsets, per-shot components",
    "taking {frame, dur}, persistent chrome, motion helpers). Its company, copy and numbers are",
    "invented for a different product: do not reuse any of them.",
    "```tsx",
    input.exemplar,
    "```",
    "",
    `LENGTH: exactly ${input.targetFrames} frames at 30fps. Declare it as AUTHORED_FRAMES.`,
    "",
    ...(input.grammar ? [GRAMMAR_BRIEF[input.grammar], ""] : []),
    "",
    "THE PRODUCT — everything on screen comes from here:",
    JSON.stringify(input.intake, null, 2),
    "",
    "ONE RULE DECIDES WHETHER THIS FILM LOOKS GENERATED, AND IT IS THE LAST THING YOU READ:",
    "NOTHING IS EVER STILL. Every shot carries at least one value still changing on its FINAL",
    "frame. An entrance is not motion, it is the first second of it. A shot whose animation",
    "finishes early becomes a slide, and a sequence of slides with cuts between them is the",
    "generated look this film exists to avoid.",
    "Motion must be at least one pixel or one unit PER FRAME to exist at all. A number counting,",
    "a bar filling, a cursor travelling, a list scrolling under a mask, a panel easing in scale,",
    "a scan band crossing, a thread advancing by one row: pick one per shot and let it run the",
    "whole shot. A 16 pixel drift across 110 frames is invisible and does not count.",
    "Measured: a film where 91 percent of frames barely change has failed. Under 20 percent is",
    "the bar. Check each shot you write against that before you move to the next one.",
  ].join("\n");

  let raw: string;
  try {
    raw = await complete(SYSTEM, user);
  } catch (e) {
    return { ok: false, error: `author_llm_error:${(e as Error).message.slice(0, 120)}` };
  }

  const tsx = extractTsx(raw);
  if (!tsx) return { ok: false, error: "no_code_block" };

  const check = checkAuthoredFilm(tsx, input.targetFrames);
  if (!check.ok) return { ok: false, error: check.error };

  return { ok: true, tsx };
}
