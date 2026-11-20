
export const STEP_TITLES = ["Start from your past work", "Add connectors", "Polishing strategy"] as const;
export const STEP_SUBS = [
  "Notes, plans, retros or memory files. I'll build on what they say.",
  "Connect where your numbers live, so I can measure what actually moves.",
  null,
] as const;
export const stepOf = (n: number) => `Step ${n} of 3`;
export const STEPS_SHEET_TITLE = "Setup steps";
export const STEPS_SHEET_OK = "Okay";
export const STEPS_SHEET_BODY = "Three quick steps so your growth strategy starts from what's true for you. You can open a finished step again any time.";
export const RAIL_NOW = "In progress";
export const RAIL_LATER = "Up next";
export const RAIL_SKIPPED = "Skipped";
export const RAIL_DONE = "Done";
export const backToStep = (n: number) => `Back to step ${n}`;

export const PREVIEW_HEADING = "What Zavi knows";
export const previewHeading = (name: string) => `What Zavi knows about ${name}`;
export const KNOWS_WEBSITE = "Website";
export const KNOWS_FILES = "Files";
export const KNOWS_APPS = "Apps";
export const PREVIEW_LOADING = "Checking…";
export const PREVIEW_UNAVAILABLE = "Couldn't load this right now";
export const PREVIEW_NO_SITE = "No website on file";
export const PREVIEW_NONE_YET = "None yet";
export const step1Reading = (name: string) => `${name} added. Reading it in the background.`;
export const stripFiles = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
export const COOKING_LABEL = "Growth strategy is cooking";
export const COOKED_LABEL = "Growth strategy is ready";
export const STRATEGY_CARD_WRITING = "Zavi is writing your growth strategy";
export const STRATEGY_CARD_WRITING_DETAIL = "Ready in about 15 minutes";
export const STRATEGY_CARD_READY = "Your growth strategy is ready";
export const STRATEGY_CARD_FAILED = "Your growth strategy didn't finish";
export const STRATEGY_CARD_OPEN = "Open your growth plan";

export const WHY_TITLE = "Why this step?";
export const WHY = [
  "Why your past work? You've already learned a lot the hard way: what worked, what didn't, your real numbers. From your website alone I'd guess, and I might suggest things you already tried. Your files let me build the strategy on what's true for you. Every fact shows the file it came from, and you can remove any of them on the web in Settings → Personalization. No files? Skip. You can add them later under Company Details.",
  "Why connectors? So I can measure instead of guess. Stripe tells me revenue, Google Analytics where people drop off, Meta Ads what your ads cost. Without them your strategy runs on estimates, and I can't prove what moved. Not ready? Skip. You can connect them later from Connectors.",
  "Why these? Your company details and brand decide who I measure you against and how everything I make for you sounds and looks: ads, posts, emails. Thirty seconds here saves fixing every draft later. Then your growth strategy opens, and you can change it any time.",
] as const;

export const SKIP_STEP = "Skip this step";
export const SKIP_YES = "Yes, skip";
export const SKIP_NO = "Go back";
export const SKIP1_TITLE = "Skip your past work?";
const SKIP1_BODY = "I'll start from your website only, so the strategy leans on guesses. You can add files any time later from Company Details → Add knowledge.";
const SKIP1_BODY_KNOWN = "I'll start from what I already know about your business, so the strategy leans on guesses. You can add files any time later from Company Details → Add knowledge.";
const SKIP1_BODY_SCRATCH = "I'll start from your idea and what you told me about it, so the strategy leans on guesses. You can add files any time later from Company Details → Add knowledge.";
export const skip1Body = (oneState: boolean, fromScratch = false) =>
  fromScratch ? SKIP1_BODY_SCRATCH : oneState ? SKIP1_BODY_KNOWN : SKIP1_BODY;
export const SKIP2_TITLE = "Skip connectors?";
export const SKIP2_BODY = "Without them your strategy runs on estimates, and I can't measure what actually moves. You can connect them any time later from Connectors.";
export const SKIP3_TITLE = "Skip polishing?";
const SKIP3_BODY = "I'll use what I found on your website. You can change these any time in Company Details.";
const SKIP3_BODY_KNOWN = "I'll use what I already know about your business. You can change these any time in Company Details.";
const SKIP3_BODY_SCRATCH = "I'll use what you told me about your idea. You can change these any time in Company Details.";
export const skip3Body = (oneState: boolean, fromScratch = false) =>
  fromScratch ? SKIP3_BODY_SCRATCH : oneState ? SKIP3_BODY_KNOWN : SKIP3_BODY;

export const SKIP_ALL_LABEL = "Skip setup, take me in";
export const SKIP_ALL_TITLE = "Skip setup for now?";
export const SKIP_ALL_YES = "Take me in";
export const SKIP_ALL_NO = "Keep going";
const SKIP_ALL_BODY = "I'll start from your website. You can add files under Company Details and connect apps from Connectors any time.";
const SKIP_ALL_BODY_KNOWN = "I'll start from what I already know about your business. You can add files under Company Details and connect apps from Connectors any time.";
const SKIP_ALL_BODY_SCRATCH = "I'll start from your idea and what you told me about it. You can add files under Company Details and connect apps from Connectors any time.";
export const skipAllBody = (oneState: boolean, fromScratch = false) =>
  fromScratch ? SKIP_ALL_BODY_SCRATCH : oneState ? SKIP_ALL_BODY_KNOWN : SKIP_ALL_BODY;
export const SKIP_ALL_BODY_UNSAVED = "Your changes on this step are not saved yet. Skipping now leaves them out.";
export const SWITCH_COMPANY = "Switch company";

export const PICK_TITLE = "Drop files here, or click to choose";
export const PICK_LIMITS = ".md .txt .pdf .docx .csv .json · up to 20 files · 25 MB each";
export const CHOOSE_FILES = "Choose files";
export const CONTINUE = "Continue";
export const CODING_TOOL_TOGGLE = "Have a code project? Get a prompt for your coding tool";
export const BUNDLE_TITLE = "Using Claude Code or Codex?";
export const BUNDLE_HELP = "Paste this prompt into it in your project folder. It writes one zavi-context.md file you can add here.";
export const COPY_PROMPT = "Copy prompt";
export const COPIED = "Copied";
export const SEE_PROMPT = "See the prompt";
export const HIDE_PROMPT = "Hide the prompt";
export const learnedLine = (facts: number, files: number) =>
  `I learned ${facts} ${facts === 1 ? "thing" : "things"} from ${files} ${files === 1 ? "file" : "files"}.`;
export const LEARNED_WHERE = "You can see or remove any of them later on the web, in Settings → Personalization.";
export const keysRemovedLine = (n: number, file: string) =>
  `I removed ${n} ${n === 1 ? "thing" : "things"} that looked like keys from ${file}`;
export const couldntRead = (reason: string) => `Couldn't read this one (${reason})`;
export const STORED_IMAGE = "Saved, not read (image)";
export const TRUNCATED_LINE = "I read the first part of this file (about 30 pages).";
export const removeFileTitle = (name: string) => `Remove ${name}?`;
export const REMOVE_FILE_BODY = "The file and every fact it gave are removed. Agents stop using them.";
export const REMOVE_FILE_YES = "Remove";
export const REMOVE_FAILED = "Couldn't remove that file. Try again.";
export const PICKER_MISSING = "Adding files needs the latest version of the app.";
export const ONLY_FIRST = (n: number) => `Only the first ${n} files were added. Choose the rest again.`;

export const COMPACT_HEADING = "Most useful to start";
export const SEARCH_PLACEHOLDER = "Search all apps: Salesforce, Intercom, Notion…";
export const results = (n: number) => `${n} result${n === 1 ? "" : "s"}`;
export const noAppFound = (q: string) =>
  `No app called “${q}” yet. Ask me in the chat and I'll tell you how to connect it.`;
export const continueLabel = (n: number) => (n === 0 ? "Continue" : `Continue with ${n} connected`);
export const CONNECTED = "Connected";
export const CONNECT = "Connect";
export const COMING_SOON = "Coming soon";
export const CONNECTORS_LOAD_FAILED = "Couldn't check your connections. Pull down or come back to this step to try again.";
export const MEMBER_READ_ONLY = "Only an owner or admin can connect apps.";

const introSource = (fromFiles: boolean, hasWebsite: boolean) =>
  fromFiles ? (hasWebsite ? "your files and website" : "your files") : hasWebsite ? "your website" : "your idea";
export const polishIntro = (fromFiles: boolean, hasWebsite = true) =>
  `Two quick things so the strategy fits you. I filled in what ${introSource(fromFiles, hasWebsite)} told me; fix anything that's off.`;
export const polishIntroReading = (name: string) =>
  `Two quick things so the strategy fits you. For now these are my guesses from your website. I'm still reading ${name}; you can finish now, and anything you change stays yours.`;
export const COMPANY_DETAILS = "Company details";
export const COMPANY_NAME_HINT = "Your company name";
export const WEBSITE_HINT = "yourcompany.com";
export const WHAT_YOU_DO_HINT = "What you sell, and to whom";
export const BRAND = "Brand";
export const FINDING_COMPETITORS = "Finding competitors…";
export const COMPETITORS_FOUND = "I found these from what you told me. Remove any that don't fit, or add your own.";
export const NO_COMPETITORS_FOUND = "I couldn't find any yet. Add the ones you know.";
export const ADD_COMPETITOR = "Add a competitor";
export const TONE_LABEL_Q = "How should you sound?";
export const COLOURS_LABEL = "Brand colours";
export const FINISH_LABEL = "I’m ready, let’s grow";
export const SAVING_LABEL = "Saving…";
export const fromFile = (name: string) => `From ${name}`;
export const USE_WEBSITE_GUESS = "Use website guess instead";
export const fileSays = (name: string, value: string) => `${name} says "${value}". You changed this, so I kept yours.`;
export const USE_FILE_LINE = "Use the file's line";
export const USE_FILE_LIST = "Use the file's list";
export const KEEP_MINE = "Keep mine";
export const FILE_DETAILS_FAILED = "I couldn't load your file's details. You can finish now and fix them later in Company Details.";
export const PREFILL_FAILED = "Some of your details didn’t load. You can still finish and fix them later in Company Details.";
export const finishNote = (problems: string[]) =>
  `Some details didn't save (${problems.join(", ")}). You can change them in Company Details.`;

export const MARK_FAILED = (status: number) => `Could not save that step (HTTP ${status}).`;
export const LOAD_FAILED = "Couldn't load your setup. Check your connection and try again.";
export const TRY_AGAIN = "Try again";

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
