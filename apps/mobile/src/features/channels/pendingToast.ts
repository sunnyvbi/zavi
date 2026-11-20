let pending: string | null = null;

export function setPendingToast(message: string): void {
  pending = message;
}

export function takePendingToast(): string | null {
  const m = pending;
  pending = null;
  return m;
}
