import {
  listAppCodeTree,
  readAppCodeFile,
  type AppCodeEntry,
} from "@/services/provisioning/app-code";

const MAX_ROUTE_PATHS = 40;
const MAX_SOURCE_FILES = 4;
const MAX_SOURCE_CHARS = 6_000;

const ENTRY_CANDIDATES = [
  "src/app/page.tsx",
  "app/page.tsx",
  "src/pages/index.tsx",
  "pages/index.tsx",
  "src/App.tsx",
  "src/App.jsx",
  "src/app/home/page.tsx",
  "app/home/page.tsx",
];

function relevantSourcePaths(entries: AppCodeEntry[]): string[] {
  const files = entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
  const picked: string[] = [];
  const add = (path: string | undefined) => {
    if (path && !picked.includes(path)) picked.push(path);
  };
  for (const candidate of ENTRY_CANDIDATES) add(files.find((path) => path === candidate));
  for (const path of files) {
    if (picked.length >= MAX_SOURCE_FILES) break;
    if (/\/(?:page|index)\.(?:tsx|jsx|ts|js)$/i.test(`/${path}`)) add(path);
  }
  return picked.slice(0, MAX_SOURCE_FILES);
}

export async function readBuiltAppSuggestionContext(args: {
  full_name: string;
  branch: string;
  token: string;
}, deps: {
  listTree?: typeof listAppCodeTree;
  readFile?: typeof readAppCodeFile;
} = {}): Promise<string | null> {
  try {
    const listTree = deps.listTree ?? listAppCodeTree;
    const readFile = deps.readFile ?? readAppCodeFile;
    const tree = await listTree(args);
    const routePaths = tree.entries
      .filter(
        (entry) =>
          entry.type === "file" &&
          /(?:^|\/)(?:page|index)\.(?:tsx|jsx|ts|js|html)$/i.test(entry.path),
      )
      .map((entry) => entry.path)
      .slice(0, MAX_ROUTE_PATHS);
    const source: string[] = [];
    for (const path of relevantSourcePaths(tree.entries)) {
      const file = await readFile({ ...args, path });
      if (file.kind === "text") {
        source.push(`FILE ${path}\n${file.content.slice(0, MAX_SOURCE_CHARS)}`);
      }
    }
    if (routePaths.length === 0 && source.length === 0) return null;
    return [
      `ROUTE FILES\n${routePaths.length > 0 ? routePaths.join("\n") : "(none found)"}`,
      ...source,
    ].join("\n\n");
  } catch {
    return null;
  }
}
