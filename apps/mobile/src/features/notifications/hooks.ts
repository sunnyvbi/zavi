import { useCallback, useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";

export type NotificationSettings = {
  agent_replies: boolean;
  approvals: boolean;
  daily_brief: boolean;
  growth_lead?: boolean;
  result_milestone?: boolean;
  connector_broke?: boolean;
};

const keyFor = (tenant: string) => ["notification-settings", tenant] as const;

function fetchSettings(): Promise<NotificationSettings> {
  return apiJson<NotificationSettings>("/api/mobile/notification-settings");
}

export function useNotificationSettings() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: keyFor(tenant),
    queryFn: fetchSettings,
    enabled: tenant !== "none",
  });
}

export function useUpdateNotificationSettings() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const key = keyFor(tenant);

  return useMutation({
    mutationFn: (patch: Partial<NotificationSettings>) =>
      apiJson<NotificationSettings>("/api/mobile/notification-settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<NotificationSettings>(key);
      if (prev) qc.setQueryData<NotificationSettings>(key, { ...prev, ...patch });
      return { prev };
    },
    onError: (_e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => {
      qc.setQueryData(key, data);
    },
  });
}

export type PushPermission = "unknown" | "granted" | "ask" | "blocked";

export function usePushPermission() {
  const [permission, setPermission] = useState<PushPermission>(
    Platform.OS === "web" ? "granted" : "unknown",
  );

  const refresh = useCallback(async () => {
    if (Platform.OS === "web") return;
    const p = await Notifications.getPermissionsAsync();
    setPermission(p.granted ? "granted" : p.canAskAgain ? "ask" : "blocked");
  }, []);

  useEffect(() => {
    void refresh().catch(() => {});
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refresh().catch(() => {});
    });
    return () => sub.remove();
  }, [refresh]);

  return { permission, refresh };
}
