
const STORAGE_KEY = "zavi:pending-build-start";
const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

type Pending = { signature: string; requestId: string };
let pending: Pending | null = null;

export function buildStartBody(input: {
  idea: string;
  company_name: string | null | undefined;
  reference_images?: string[];
  template?: string | null;
  figma?: { file_key: string; node_id: string } | null;
}): string {
  return JSON.stringify({
    idea: input.idea.trim(),
    company_name: (input.company_name ?? "").trim() || "My Company",
    ...(input.reference_images && input.reference_images.length ? { reference_images: input.reference_images } : {}),
    ...(input.template ? { template: input.template } : {}),
    ...(input.figma ? { figma: { file_key: input.figma.file_key, node_id: input.figma.node_id } } : {}),
    await_look_pick: true,
  });
}

function readStored(): Pending | null {
  try {
    const raw = typeof window !== "undefined" ? window.sessionStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Pending> | null;
    if (typeof parsed?.signature === "string" && typeof parsed?.requestId === "string" && KEY_RE.test(parsed.requestId)) {
      return { signature: parsed.signature, requestId: parsed.requestId };
    }
  } catch {
  }
  return null;
}

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `build-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildStartKey(body: string): string {
  pending = readStored() ?? pending;
  if (!pending || pending.signature !== body) pending = { signature: body, requestId: newKey() };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
  }
  return pending.requestId;
}

export function keepsBuildStartKey(code: string | null | undefined): boolean {
  return code === "idempotency_in_progress" || code === "idempotency_stale";
}

export function clearBuildStartKey(requestId: string): void {
  if (pending && pending.requestId !== requestId) return;
  const stored = readStored();
  if (stored && stored.requestId !== requestId) return;
  pending = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}

export function _resetBuildStartKeyForTests(): void {
  pending = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}
