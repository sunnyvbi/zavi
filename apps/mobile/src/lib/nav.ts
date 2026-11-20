import { router } from "expo-router";

type Target = Parameters<typeof router.replace>[0];

let lastTarget: string | null = null;

export function resetTo(href: Target): void {
  const key = typeof href === "string" ? href : JSON.stringify(href);
  if (lastTarget === key) return;
  lastTarget = key;
  if (router.canDismiss()) router.dismissAll();
  router.replace(href);
}

export function popBackTo(href: Target): void {
  lastTarget = typeof href === "string" ? href : JSON.stringify(href);
  router.dismissTo(href);
}
