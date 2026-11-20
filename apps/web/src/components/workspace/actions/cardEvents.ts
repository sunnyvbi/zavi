import { trackEvent, type EventProps } from "@/lib/analytics/events";
import type { ActionHandlers, ActionItem } from "./types";

export type CardEvent = "card_shown" | "card_opened" | "card_primary_clicked" | "card_dismissed";

export function cardEventProps(a: ActionItem, tenantId: string | null | undefined): EventProps {
  return {
    action_id: a.id,
    action_type: a.action_type,
    channel: a.channel_slug,
    card_kind: a.card_kind ?? null,
    executable: a.executable,
    status: a.status,
    tenant_id: tenantId ?? null,
  };
}

export function trackCardEvent(event: CardEvent, a: ActionItem, tenantId: string | null | undefined, extra?: EventProps): void {
  trackEvent(event, { ...cardEventProps(a, tenantId), ...extra });
}

export function withCardEvents(handlers: ActionHandlers, tenantId: string | null | undefined): ActionHandlers {
  return {
    ...handlers,
    onSetStatus: (...args) => {
      const [a, status, opts] = args;
      const { via, ...rest } = opts ?? {};
      const pass = opts ? rest : undefined;
      if (status === "acted") {
        trackCardEvent("card_primary_clicked", a, tenantId, { action: via ?? "done" });
        return handlers.onSetStatus(a, status, pass);
      }
      const result = handlers.onSetStatus(a, status, pass);
      void Promise.resolve(result).then(
        (r) => {
          if (r !== false) trackCardEvent("card_dismissed", a, tenantId, { reason: status });
        },
        () => {},
      );
      return result;
    },
    ...(handlers.onApprove && {
      onApprove: (...args: Parameters<NonNullable<ActionHandlers["onApprove"]>>) => {
        trackCardEvent("card_primary_clicked", args[0], tenantId, { action: "approve" });
        return handlers.onApprove!(...args);
      },
    }),
  };
}
