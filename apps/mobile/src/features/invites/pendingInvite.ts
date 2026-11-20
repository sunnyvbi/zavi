import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "zavi.pendingInvite";

export async function setPendingInvite(id: string): Promise<void> {
  await AsyncStorage.setItem(KEY, id).catch(() => {});
}

export async function getPendingInvite(): Promise<string | null> {
  return AsyncStorage.getItem(KEY).catch(() => null);
}

export async function clearPendingInvite(): Promise<void> {
  await AsyncStorage.removeItem(KEY).catch(() => {});
}
