export type FigmaFrameRef = { file_key: string; node_id: string };

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);
const FIGMA_KINDS = new Set(["design", "file"]);
const FILE_KEY_RE = /^[A-Za-z0-9]{10,128}$/;
const NODE_ID_RE = /^(\d{1,12})[:-](\d{1,12})$/;

export function normalizeFigmaNodeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = NODE_ID_RE.exec(raw.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

export function parseFigmaFrameUrl(raw: unknown): FigmaFrameRef | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!FIGMA_HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !FIGMA_KINDS.has(parts[0])) return null;
  const file_key = parts[1];
  if (!FILE_KEY_RE.test(file_key)) return null;
  const node_id = normalizeFigmaNodeId(url.searchParams.get("node-id"));
  return node_id ? { file_key, node_id } : null;
}

export function parseFigmaFrameRef(raw: unknown): FigmaFrameRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes("file_key") || !keys.includes("node_id")) return null;
  const { file_key, node_id } = raw as { file_key: unknown; node_id: unknown };
  if (typeof file_key !== "string" || !FILE_KEY_RE.test(file_key)) return null;
  const node = normalizeFigmaNodeId(node_id);
  return node ? { file_key, node_id: node } : null;
}
