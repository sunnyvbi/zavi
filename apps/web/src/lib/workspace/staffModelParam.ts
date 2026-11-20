
let scope = "anon";
let current: string | undefined;
const key = () => `zavi.staff_model:${scope}`;

export function setStaffModelScope(userId: string | undefined | null, tenantId: string | undefined | null): void {
  const next = userId && tenantId ? `${userId}:${tenantId}` : "anon";
  if (next !== scope) {
    scope = next;
    current = undefined;
  }
}

export function captureStaffModelParam(search: string): void {
  const v = new URLSearchParams(search).get("model");
  if (v === null) return;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "claude") {
    current = undefined;
    try {
      sessionStorage.removeItem(key());
    } catch {
    }
    return;
  }
  current = t;
  try {
    sessionStorage.setItem(key(), t);
  } catch {
  }
}

export function getStaffModelParam(): string | undefined {
  if (typeof window === "undefined") return undefined;
  captureStaffModelParam(window.location.search);
  if (current) return current;
  try {
    return sessionStorage.getItem(key()) ?? undefined;
  } catch {
    return undefined;
  }
}

export function staffModelBodyField(): { model?: string } {
  const m = getStaffModelParam();
  return m ? { model: m } : {};
}

export function staffModelLabel(staffModelKey: string | null | undefined, modelUsed: string | null | undefined): string | null {
  if (!staffModelKey) return null;
  return modelUsed ? `answered by ${staffModelKey} · ${modelUsed}` : `answered by ${staffModelKey}`;
}

export function _resetForTests(): void {
  current = undefined;
  scope = "anon";
}
