export type FileRef = { name: string; url: string };

const WORKSPACE_FILE_URL =
  /^https?:\/\/\S+\/api\/public\/workspace-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[^\s/]+$/i;
const REF_LINE = /^(.*\S)\s*:\s+(https?:\/\/\S+)$/;

export function isWorkspaceFileUrl(url: string): boolean {
  return WORKSPACE_FILE_URL.test(url);
}

export function fileRefsLead(count: number, collectionName?: string): string {
  if (collectionName) return `Use the "${collectionName}" photos on the site:`;
  return count === 1 ? "Use this photo on the site:" : "Use these photos on the site:";
}

export function appendFileRefs(text: string, files: ReadonlyArray<FileRef>, collectionName?: string): string {
  if (files.length === 0) return text;
  const block = [fileRefsLead(files.length, collectionName), ...files.map((f) => `${f.name}: ${f.url}`)].join("\n");
  const body = text.trim();
  return body ? `${body}\n\n${block}` : block;
}

const FILE_URL_SOURCE =
  "https?:\\/\\/\\S+\\/api\\/public\\/workspace-files\\/[0-9a-f-]{36}\\/[0-9a-f-]{36}\\/[^\\s/]+";
const LEAD_ANYWHERE = /Use (?:this photo|these photos|the "[^"\n]*" photos) on the site:/g;
const LEAD_ONCE = /Use (?:this photo|these photos|the "[^"\n]*" photos) on the site:/;
const LEAD_TEST = /Use (?:this photo|these photos|the "[^"\n]*" photos) on the site:\s*\S/;

export function splitFileRefs(text: string): { body: string; files: FileRef[] } {
  if (!text.includes("/api/public/workspace-files/")) return { body: text, files: [] };
  const files: FileRef[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const match = LEAD_TEST.test(line) ? null : REF_LINE.exec(line.trim());
    if (match && !match[1]!.includes("//") && isWorkspaceFileUrl(match[2]!)) files.push({ name: match[1]!, url: match[2]! });
    else kept.push(line);
  }
  const inline = new RegExp(`([^:\\n]+?):\\s+(${FILE_URL_SOURCE})(?=\\s|$)`, "gi");
  const rest = kept
    .map((line) => {
      const lead = LEAD_ONCE.exec(line);
      if (!lead) return line;
      const after = line.slice(lead.index + lead[0].length);
      const urls = new RegExp(`:\\s+(${FILE_URL_SOURCE})(?=\\s|$)`, "gi");
      let cursor = 0;
      for (let m = urls.exec(after); m; m = urls.exec(after)) {
        const name = after.slice(cursor, m.index).trim();
        if (!name) break;
        files.push({ name, url: m[1]! });
        cursor = m.index + m[0].length;
      }
      return cursor > 0 ? line.slice(0, lead.index) + after.slice(cursor) : line;
    })
    .join("\n")
    .replace(inline, (_all, name: string, url: string) => {
      files.push({ name: name.trim(), url });
      return "";
    });
  if (files.length === 0) return { body: text, files };
  const body = rest
    .replace(LEAD_ANYWHERE, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, files };
}

export function mergeFileRefs(current: ReadonlyArray<FileRef>, incoming: ReadonlyArray<FileRef>): FileRef[] {
  const seen = new Set(current.map((f) => f.url));
  return [...current, ...incoming.filter((f) => !seen.has(f.url) && seen.add(f.url))];
}

export function sameFileRefs(a: ReadonlyArray<FileRef>, b: ReadonlyArray<FileRef>): boolean {
  return a.length === b.length && a.every((f, i) => f.url === b[i]!.url && f.name === b[i]!.name);
}
