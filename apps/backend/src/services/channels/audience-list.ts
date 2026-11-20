const HEADER = /^\s*AUDIENCE\s+(\d+|[A-Z](?![A-Za-z]))\s*[:.-]\s*(.*)$/i;
const KEY = /^([A-Z][A-Za-z0-9 ()/&'-]{0,40}):\s*(.*)$/;
const NEXT_KEY = /\s{2,}(?=[A-Z][A-Za-z0-9 ()/&'-]{0,40}:\s)/;

function rowCount(line: string): number {
  const head = KEY.exec(line.trim());
  if (!head) return 0;
  return 1 + head[2].split(NEXT_KEY).slice(1).reduce((n, part) => n + rowCount(part), 0);
}

export function isAudienceList(content: string | null | undefined): boolean {
  if (!content) return false;
  const counts: number[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (HEADER.test(line)) counts.push(0);
    else if (counts.length && line.trim()) counts[counts.length - 1] += rowCount(line);
  }
  return counts.length > 0 && counts.every((n) => n >= 2);
}
