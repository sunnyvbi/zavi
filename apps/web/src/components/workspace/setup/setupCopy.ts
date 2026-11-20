
export const SETUP_TITLE = "Welcome to Zavi.";
export const setupSubtitle = (n: number) => `To cook your growth strategy, finish these ${n} steps.`;
export const COOKING_LABEL = "Growth strategy is cooking";
export const COOKED_LABEL = "Growth strategy is ready";

export const STEP1_TITLE = "Start from your past work";
export const STEP2_TITLE = "Add connectors";
export const STEP3_TITLE = "Polishing strategy";

export const WHY_STEP1 =
  "Why your past work? You've already learned a lot the hard way: what worked, what didn't, your real numbers. From your website alone I'd guess, and I might suggest things you already tried. Your files let me build the strategy on what's true for you. Every fact shows the file it came from, and you can remove any of them in Settings → Personalization. No files? Skip. You can add them later under Company Details.";
export const WHY_STEP2 =
  "Why connectors? So I can measure instead of guess. Stripe tells me revenue, Google Analytics where people drop off, Meta Ads what your ads cost. Without them your strategy runs on estimates, and I can't prove what moved. Not ready? Skip. You can connect them later from Connectors.";
export const WHY_STEP3 =
  "Why these? Your company details decide who I measure you against and what everything I make for you is about: ads, posts, emails. Thirty seconds here saves fixing every draft later. Then you land in chat while your growth strategy finishes, and you can change it any time.";

export const step1SummaryDone = (facts: number, files: number) =>
  `${facts} facts from ${files} ${files === 1 ? "file" : "files"}. Add more any time under Company Details.`;
export const STEP2_SUMMARY_SKIPPED = "Connect them any time from Connectors.";

export const DROP_TITLE = "Drop files here, or click to choose";
export const DROP_LIMITS = ".md .txt .pdf .docx .csv .json · up to 20 files · 25 MB each";
export const DROP_HINT = "Notes, plans, retros or memory files. I'll build on what they say.";
export const BUNDLE_TITLE = "Using Claude Code or Codex?";
export const BUNDLE_HELP = "Paste this prompt into it in your project folder. It writes one zavi-context.md file you can drop here.";
export const CODING_TOOL_TOGGLE = "Have a code project? Get a prompt for your coding tool";
export const SEE_PROMPT = "See the prompt";
export const HIDE_PROMPT = "Hide the prompt";
export const learnedLine = (facts: number, files: number) =>
  `I learned ${facts} ${facts === 1 ? "thing" : "things"} from ${files} ${files === 1 ? "file" : "files"}.`;
export const LEARNED_WHERE = "You can see or remove any of them later in Settings → Personalization.";
export const keysRemovedLine = (n: number, file: string) =>
  `I removed ${n} ${n === 1 ? "thing" : "things"} that looked like keys from ${file}`;
export const couldntRead = (reason: string) => `Couldn't read this one (${reason})`;
export const STORED_IMAGE = "Saved, not read (image)";
export const TRUNCATED_LINE = "I read the first part of this file (about 30 pages).";

export const STEP2_INTRO = "Connect where your numbers live, so I can measure what actually moves.";
export const MESSAGING_HEADING = "Talk to Zavi where you already are";
export const COMPACT_HEADING = "Most useful to start";
export const TOP_HEADING = "Everything else · top 20";
export const SEARCH_PLACEHOLDER = "Search all apps: Salesforce, Intercom, Notion…";
export const noAppFound = (q: string) =>
  `No app called “${q}” yet. Ask me in the chat and I'll tell you how to connect it.`;
export const continueLabel = (n: number) => (n === 0 ? "Continue" : `Continue with ${n} connected`);

const introSource = (fromFiles: boolean, hasWebsite: boolean) =>
  fromFiles ? (hasWebsite ? "your files and website" : "your files") : hasWebsite ? "your website" : "your idea";
export const polishIntro = (fromFiles: boolean, hasWebsite = true) =>
  `Two quick things so the strategy fits you. I filled in what ${introSource(fromFiles, hasWebsite)} told me; fix anything that's off.`;
export const FINDING_COMPETITORS = "Finding competitors…";
export const COMPETITORS_FOUND = "I found these from what you told me. Remove any that don't fit, or add your own.";
export const NO_COMPETITORS_FOUND = "I couldn't find any yet. Add the ones you know.";
export const FINISH_LABEL = "I’m ready, let’s grow";
export const SAVING_LABEL = "Saving…";

export const READY_TITLE = "Your growth strategy is ready.";
export const BUILDING_LINE = "Building your growth strategy. This page updates automatically as your plan is prepared.";
export const READY_LINE = "Your growth strategy is ready. You did it. Let's grow!";
export const READY_BODY = "It’s your goal now. Everything else in Zavi is open.";
export const GO_HOME = "Go to Home";
export const DRAFT_FAILED = "Something went wrong cooking your strategy";
export const TRY_AGAIN = "Try again";

export const FAQ_SUGGESTIONS = [
  "Why do you need my files?",
  "Is my data safe?",
  "What if I have no files?",
  "How long does this take?",
] as const;

export const WAITING_FOR_FILE = "Waiting for your file";
export const STEP1_SUMMARY_SKIPPED_A = "Skipped. Add files any time under Company Details.";
export const step1Reading = (name: string) => `${name} added. Reading it in the background.`;
export const step1Read = (facts: number, name: string) =>
  `${facts} ${facts === 1 ? "fact" : "facts"} from ${name}. See or remove them any time in Settings → Personalization.`;
export const step1Failed = (name: string, reason: string) =>
  `Couldn't read ${name} (${reason}). Your strategy will use your website.`;
export const step1Stored = (name: string) => `${name} saved. Images are kept, not read.`;
export const TRY_ANOTHER_FILE = "Try another file";
export const ADD_FILES = "Add files";
export const ADD_CONNECTORS = "Add connectors";
export const REOPEN_DONE = "Done";
export const ALREADY_COOKING =
  "Your strategy is already cooking. New files and connectors go into your brain and the next update, not this draft.";
export const polishIntroReading = (name: string) =>
  `Two quick things so the strategy fits you. For now these are my guesses from your website. I'm still reading ${name}; you can finish now, and anything you change stays yours.`;
export const fromFile = (name: string) => `From ${name}`;
export const USE_WEBSITE_GUESS = "Use website guess instead";
export const fileSays = (name: string, value: string) => `${name} says "${value}". You changed this, so I kept yours.`;
export const USE_FILE_LINE = "Use the file's line";
export const USE_FILE_LIST = "Use the file's list";
export const KEEP_MINE = "Keep mine";
export const afterWaiting = (name: string) => `Setup is done. Your strategy starts the moment I finish reading ${name}.`;
export const AFTER_LEAVE = "You can leave this page; I'll keep going.";
export const afterReadingOnly = (name: string) => `I'm still reading ${name}. Anything it adds goes into your brain.`;
export const afterReadLine = (name: string) => `I read ${name}.`;
export const afterFilled = (labels: string[]) => ` I filled in ${labels.join(", ")}, where you'd kept my website guess.`;
export const AFTER_CONFLICTS = " If it disagrees with a detail you set, I'll ask you in the chat.";
export const afterFailed = (name: string, reason: string) =>
  `I couldn't read ${name} (${reason}), so this uses your website and your details.`;

export const BUNDLE_PROMPT = `You are helping me brief Zavi, my AI growth agent, on this business. Read what's in this project and write ONE file, zavi-context.md, that a new growth lead could trust on day one.

READ (only what exists; skip what doesn't):
- CLAUDE.md, AGENTS.md, README*, and anything under docs/, notes/, plans/, retros/
- Your own memory files for this project (for Claude Code: the project's memory folder)
- git log for the last 6 months (commit messages only, to see what shipped and when)
- Any metrics, pricing, experiment or launch notes you find

WRITE zavi-context.md with exactly these sections:
1. The business: what we sell, to whom, price, business model, stage.
2. The customer: who buys, who uses, why they choose us, who we lose to.
3. The one number that matters: the metric, its current value and the date of that value, and the target.
4. Where we lose people: each funnel step we know about, with numbers and dates.
5. How customers find us: channels, with share or volume where known.
6. What we tried: one line each as "what | when | result | keep or stop".
7. Decisions and constraints: things we've ruled out, budgets, rules (e.g. never discount above 20%).
8. Open questions: what we don't know yet.

RULES:
- Facts only. After every line, cite where it came from, e.g. (docs/retro-aug.md:14) or (git 3f2a1c9).
- Give every number a date. If two sources disagree, write both with their sources.
- Mark anything you inferred as "(inferred)". Leave a section empty rather than guessing.
- Never include secrets, API keys, passwords, tokens, or customers' personal data.
- Keep it under 3,000 words. Plain markdown, no tables wider than 4 columns.

SAVE IT where I can find it: on the Desktop my computer actually shows (~/Desktop on Mac or Linux; on Windows ask the system for the real Desktop folder, because with OneDrive it is often %USERPROFILE%\\OneDrive\\Desktop, not %USERPROFILE%\\Desktop). If you can't find the Desktop, save it in my home folder. Do not save it inside this project and do not commit it. If you are not allowed to write outside this project (a sandbox or a hosted workspace), save it at the top of this project instead, do not commit it, and tell me that is where it is.

When you're done, tell me the full file path so I can upload it to Zavi.`;
export const FILE_DETAILS_FAILED = "I couldn't load your file's details. You can finish now and fix them later in Company Details.";

export const stepOf = (n: number) => `Step ${n} of 3`;
export const SKIP_ALL_LABEL = "Skip setup, take me in";
export const SKIP_ALL_TITLE = "Skip setup for now?";
export const SKIP_ALL_BODY_UNSAVED = "Your changes on this step are not saved yet. Skipping now leaves them out.";
export const PREVIEW_HEADING = "What Zavi knows";
export const previewHeading = (name: string) => `What Zavi knows about ${name}`;
export const chipApps = (names: string[]) => `${names.join(", ")} connected`;
export const chipStrategy = (pct: number) => `Strategy ${pct}%`;
export const STEP1_SUB = "Notes, plans, retros or memory files. I'll build on what they say.";
export const RAIL_WELCOME = "Welcome to Zavi.";
export const PREVIEW_LOADING = "Checking…";
export const PREVIEW_UNAVAILABLE = "Couldn't load this right now";
export const PREVIEW_NO_SITE = "No website on file";
export const PREVIEW_NONE_YET = "None yet";
export const PREVIEW_FILES_SKIPPED = "Skipped. Add files any time.";
export const STRIP_LEAD = "Zavi knows:";
export const STRIP_SITE = "website ✓";
export const stripFiles = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
export const stripApps = (n: number) => `${n} ${n === 1 ? "app" : "apps"}`;
export const RAIL_NOW = "In progress";
export const RAIL_LATER = "Up next";
export const RAIL_SKIPPED = "Skipped";
export const RAIL_DONE = "Done";
export const railFilesRead = (n: number) => `${n} ${n === 1 ? "file" : "files"} read`;
export const SHOW_MORE_RESULTS = "Show more";
export const LOADING_MORE = "Loading…";
export const BUILD_PANEL_TITLE = "Your growth setup is waiting";
export const BUILD_PANEL_BODY = "You can keep working on your site. When you have a minute, three short steps let Zavi draft your growth plan.";
export const BUILD_PANEL_CONTINUE = "Continue setup";
export const BUILD_PANEL_DISMISS = "Not now";
export const SETUP_BACK_TO_BUILD = "Back to your build";
export const STRATEGY_CARD_WRITING = "Zavi is writing your growth strategy";
export const STRATEGY_CARD_WRITING_DETAIL = "Ready in about 15 minutes";
export const STRATEGY_CARD_READY = "Your growth strategy is ready";
export const STRATEGY_CARD_FAILED = "Your growth strategy didn't finish";
export const STRATEGY_CARD_OPEN = "Open your growth plan";

export function strategyProgressLine(phase?: "writing" | "checking" | "saving"): string {
  if (phase === "checking") return "Checking your strategy against your business information.";
  if (phase === "saving") return "Saving your strategy and setting up your plan.";
  return "Writing your growth strategy from your business information.";
}
