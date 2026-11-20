import { useSyncExternalStore } from "react";

let current = "/workspace";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;
export function setSetupLocation(href = "/workspace") {
  current = href;
  window.history.replaceState(null, "", href);
  listeners.forEach((listener) => listener());
}
export const useRouter = () => ({ replace: setSetupLocation });
export function useSearchParams() {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot);
  return new URL(href, "http://localhost").searchParams;
}
export function usePathname() {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot);
  return new URL(href, "http://localhost").pathname;
}
