
const P_OPEN = "\x00MRKDWN_CODE_";
const P_CLOSE = "\x00";

const ACTION_SETTINGS_URL = "https://www.zaviagent.com/workspace?tab=settings";
const ACTION_CONNECT_VERBS = new Set(["connect", "reauth"]);
const ACTION_SLUGS = new Set(["linear", "jira", "slack", "stripe", "github"]);

function actionSettingsTarget(action: string): string | null {
  const colon = action.indexOf(":");
  const verb = colon === -1 ? action : action.slice(0, colon);
  const arg = colon === -1 ? "" : action.slice(colon + 1);
  if (verb === "add-repo") {
    return `${ACTION_SETTINGS_URL}#connector-github`;
  }
  const slug = /^[a-z]+/.exec(arg)?.[0] ?? "";
  if (ACTION_CONNECT_VERBS.has(verb) && ACTION_SLUGS.has(slug)) {
    return `${ACTION_SETTINGS_URL}#connector-${slug}`;
  }
  return null;
}

const MRKDWN_ACTION_LINK_RE =
  /<\/(?:__praxis_action__|praxis_action)\/([^|>]*)\|([^>]+)>/g;

export function rewriteActionLinks(md: string): string {
  if (!md) return md;
  const toLink = (label: string, action: string): string => {
    const url = actionSettingsTarget(action);
    return url ? `[${label}](${url})` : `${label} in Settings → Connectors`;
  };
  return (
    md
      .replace(
        /\[([^\]]+)\]\(\/__praxis_action__\/([^)]*)\)/g,
        (_m, label: string, action: string) => toLink(label, action),
      )
      .replace(MRKDWN_ACTION_LINK_RE, (_m, action: string, label: string) =>
        toLink(label, action),
      )
      .replace(
        /(^|[\s(])\/__praxis_action__\/([^\s)<>|]+)/g,
        (_m, pre: string, action: string) =>
          `${pre}${actionSettingsTarget(action) ?? "Settings → Connectors"}`,
      )
  );
}

export function mrkdwnActionLinksToMarkdown(text: string): string {
  if (!text) return text;
  return text.replace(
    MRKDWN_ACTION_LINK_RE,
    (_m, action: string, label: string) =>
      `[${label}](/__praxis_action__/${action})`,
  );
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length >= 2 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function renderTables(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const sep = lines[i + 1];
    const looksLikeTable =
      header?.includes("|") && sep !== undefined && isSeparatorRow(sep);
    if (!looksLikeTable) {
      out.push(header);
      continue;
    }

    const headers = splitRow(header);
    i += 2;

    const rows: string[][] = [];
    while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
      rows.push(splitRow(lines[i]));
      i++;
    }
    i--;

    rows.forEach((cells, r) => {
      const label = cells[0] || "";
      if (label) out.push(`*${label}*`);
      for (let c = 1; c < cells.length; c++) {
        const value = cells[c];
        if (!value) continue;
        const col = headers[c] || "";
        out.push(col ? `•   ${col}: ${value}` : `•   ${value}`);
      }
      if (r < rows.length - 1) out.push("");
    });
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function mdToMrkdwn(input: string): string {
  if (!input) return input;

  const codeBlocks: string[] = [];
  const stash = (m: string): string => {
    codeBlocks.push(m);
    return `${P_OPEN}${codeBlocks.length - 1}${P_CLOSE}`;
  };
  let s = input
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/`[^`\n]+`/g, stash);

  s = s.replace(/<!--[\s\S]*?-->[ \t]*\n?/g, "");

  s = rewriteActionLinks(s);

  s = s.replace(/!?\[([^\]]+)\]\((\S+?)\)/g, (_m, text: string, url: string) => `<${url}|${text}>`);

  s = s.replace(/\*\*\*(\S[\s\S]*?\S|\S)\*\*\*/g, "*$1*");
  s = s.replace(/___(\S[\s\S]*?\S|\S)___/g, "*$1*");

  s = s.replace(/\*\*(\S[\s\S]*?\S|\S)\*\*/g, "*$1*");
  s = s.replace(/__(\S[\s\S]*?\S|\S)__/g, "*$1*");

  s = s.replace(/~~(\S[\s\S]*?\S|\S)~~/g, "~$1~");

  s = s.replace(/~(?=[\d$£€¥])/g, "≈");

  s = renderTables(s)
    .split("\n")
    .map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
      if (heading) return `*${heading[1].trim()}*`;
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return "";
      return line.replace(/^(\s*)[-*+]\s+/, "$1•   ");
    })
    .join("\n");

  s = s.replace(/\n{3,}/g, "\n\n");

  s = s.replace(/\x00MRKDWN_CODE_(\d+)\x00/g, (_m, i: string) => codeBlocks[Number(i)]);

  return s;
}
