
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return s
    .replace(
      /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,
      '<a href="$2" style="color:inherit;text-decoration:underline;">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(
      /`([^`]+)`/g,
      '<code style="background:#f0f1f3;padding:1px 4px;border-radius:3px;">$1</code>',
    );
}

export function markdownToEmailHtml(md: string): string {
  const lines = escapeHtml(md).split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul style="margin:12px 0 0;padding-left:20px;line-height:1.7;">');
        inList = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const heading = line.match(/^\s*#{1,3}\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<p style="margin:20px 0 6px;font-weight:600;">${inline(heading[1])}</p>`);
      continue;
    }
    closeList();
    out.push(`<p style="margin:12px 0 0;line-height:1.7;">${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

export function markdownToEmailText(md: string): string {
  return md
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*#{1,3}\s+/, "")
        .replace(/^(\s*)[-*]\s+/, "$1• ")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1"),
    )
    .join("\n");
}

export function markdownToReplyHtml(md: string): string {
  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;' +
    'font-size:14px;color:#2B2A28;">' +
    markdownToEmailHtml(md) +
    "</div>"
  );
}
