type Guard = (proceed: () => void) => boolean;

let guard: Guard | null = null;

export function setUnappliedEditGuard(next: Guard | null): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

export function guardLeave(proceed: () => void): void {
  if (guard && guard(proceed)) return;
  proceed();
}
