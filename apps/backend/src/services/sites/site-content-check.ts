import { SITE_REPO_DIR, type SiteSandbox } from "./contract";

export const STARTER_SITE_TITLE = "New site";
export const STARTER_SITE_DESCRIPTION = "A new site, coming soon.";
export const IDEA_IMAGE_BUCKET = "agent-chat-images";
export const SIGNED_IMAGE_PATH = `/storage/v1/object/sign/${IDEA_IMAGE_BUCKET}/`;

const SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_LISTED = 5;

export type SiteContentCheckInput = {
  sandbox: SiteSandbox;
  sha: string;
  seedMeta: boolean;
  signedImages: boolean;
  since?: string | null;
};

export type SiteContentCheckResult = { ok: true } | { ok: false; reason: string; signal: string };

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? "");
  }
  return out;
}

export function readSiteMeta(html: string): { title: string | null; description: string | null } {
  const head = /<head[\s>][\s\S]*?<\/head>/i.exec(html)?.[0] ?? html;
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  let description: string | null = null;
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.name ?? "").toLowerCase() === "description" && a.content !== undefined) {
      description = a.content;
      break;
    }
  }
  return { title: t ? decode(t[1]) : null, description };
}

export function seedMetaProblems(html: string): string[] {
  const { title, description } = readSiteMeta(html);
  const problems: string[] = [];
  if (!title) problems.push("index.html has no page title");
  else if (title.toLowerCase() === STARTER_SITE_TITLE.toLowerCase()) problems.push(`the page title is still the starter title "${STARTER_SITE_TITLE}"`);
  if (!description) problems.push("index.html has no meta description");
  else if (description.toLowerCase() === STARTER_SITE_DESCRIPTION.toLowerCase()) problems.push("the meta description is still the starter text");
  return problems;
}

const SCAN_EXCLUDES = `-- . ':(exclude)*.md' ':(exclude)package-lock.json'`;

async function signedLinkFiles(sandbox: SiteSandbox, sha: string): Promise<string[]> {
  const r = await sandbox.run(`git grep -I -l -F -e '${SIGNED_IMAGE_PATH}' ${sha} ${SCAN_EXCLUDES}`, {
    cwd: SITE_REPO_DIR,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith(`${sha}:`) ? l.slice(sha.length + 1) : l));
}

export async function addedSignedLinkFiles(sandbox: SiteSandbox, since: string, sha: string): Promise<string[]> {
  if (!SHA_RE.test(since) || since === sha) return [];
  const r = await sandbox.run(`git diff --no-ext-diff --no-color -U0 --diff-filter=d ${since} ${sha} ${SCAN_EXCLUDES}`, {
    cwd: SITE_REPO_DIR,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) return [];
  const files: string[] = [];
  let header = false;
  let file = "";
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      file = "";
      continue;
    }
    if (header) {
      if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
      else if (line.startsWith("@@")) header = false;
      continue;
    }
    if (line.startsWith("+") && line.includes(SIGNED_IMAGE_PATH) && file && !files.includes(file)) files.push(file);
  }
  return files;
}

export async function checkSiteContent(input: SiteContentCheckInput): Promise<SiteContentCheckResult> {
  if ((!input.seedMeta && !input.signedImages) || !SHA_RE.test(input.sha)) return { ok: true };
  const { sandbox, sha } = input;

  if (input.seedMeta) {
    const r = await sandbox.run(`git show ${sha}:index.html`, { cwd: SITE_REPO_DIR, timeoutMs: 60_000 });
    if (r.exitCode === 0) {
      const problems = seedMetaProblems(r.stdout);
      if (problems.length > 0) {
        const reason = `the site still has starter page details: ${problems.join("; ")}`;
        return {
          ok: false,
          reason,
          signal:
            `The site check failed: ${reason}.\nIn index.html set the site's own <title> and <meta name="description">, ` +
            `and add og:title, og:description, og:type, og:url (when the address is known) and twitter:card. ` +
            `Keep public/favicon.svg (the platform drew it from the site's logo).`,
        };
      }
    }
  }

  if (input.signedImages) {
    const files = input.since ? await addedSignedLinkFiles(sandbox, input.since, sha) : await signedLinkFiles(sandbox, sha);
    if (files.length > 0) {
      const listed = files.slice(0, MAX_LISTED).join(", ");
      const reason = `the site links to a founder image by its temporary signed link (${listed})`;
      return {
        ok: false,
        reason,
        signal:
          `The site check failed: ${reason}. That link stops working 7 days after upload.\n` +
          `Download each image into the repo (for example \`curl -fsSL "<url>" -o public/reference/<name>.jpg\`) ` +
          `and use the local path (\`/reference/<name>.jpg\`). No signed storage link may stay in the code.`,
      };
    }
  }

  return { ok: true };
}
