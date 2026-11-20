import { useEffect, useState } from "react";

export function useDialogHost(active: boolean): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    setHost(document.querySelector<HTMLElement>(".workspace-shell") ?? document.body);
  }, [active]);
  return active ? host : null;
}
