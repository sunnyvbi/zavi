import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { apiFetch } from "./api";

const DEVICE_ID_KEY = "zavi.deviceId";

const ANDROID_CHANNEL_ID = "default";

let openThreadId: string | null = null;
export function setOpenThread(threadId: string | null): void {
  openThreadId = threadId;
}

export function isAboutOpenThread(data: unknown): boolean {
  const threadId = (data as { thread_id?: unknown } | null)?.thread_id;
  return typeof threadId === "string" && threadId.length > 0 && threadId === openThreadId;
}

export function initNotifications(): void {
  if (Platform.OS === "web") return;
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const quiet = isAboutOpenThread(n.request.content.data);
      return {
        shouldShowBanner: !quiet,
        shouldShowList: !quiet,
        shouldPlaySound: !quiet,
        shouldSetBadge: false,
      };
    },
  });
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: "Agent updates",
    importance: Notifications.AndroidImportance.HIGH,
  });
}

function getProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    undefined
  );
}

export async function askPushPermission(): Promise<boolean> {
  await ensureAndroidChannel();
  const settings = await Notifications.getPermissionsAsync();
  if (settings.granted || !settings.canAskAgain) return settings.granted;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function registerForPush(): Promise<void> {
  if (Platform.OS === "web") return;

  if (!(await askPushPermission())) return;

  const projectId = getProjectId();
  const { data: token } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  if (!token) return;

  const platform = Platform.OS === "ios" ? "ios" : "android";
  const res = await apiFetch("/api/devices", {
    method: "POST",
    body: JSON.stringify({ expo_push_token: token, platform }),
  });
  if (!res.ok) return;
  const body = (await res.json()) as { id?: string };
  if (body.id) {
    await AsyncStorage.setItem(DEVICE_ID_KEY, body.id);
  }
}

export async function unregisterPush(): Promise<void> {
  const id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) return;
  try {
    await apiFetch(`/api/devices/${id}`, { method: "DELETE" });
  } catch {
  }
  await AsyncStorage.removeItem(DEVICE_ID_KEY);
}
