export function revealActionInstructions(target: HTMLElement | null): void {
  if (!target) return;
  const nested = target.querySelector("details");
  if (nested) nested.open = true;
  let ancestor = target.closest("details");
  while (ancestor) {
    ancestor.open = true;
    ancestor = ancestor.parentElement?.closest("details") ?? null;
  }
  target.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}
