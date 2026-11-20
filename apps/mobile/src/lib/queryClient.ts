import { AppState, type AppStateStatus, Platform } from "react-native";
import * as Network from "expo-network";
import { QueryClient, focusManager, onlineManager } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

onlineManager.setEventListener((setOnline) => {
  const sub = Network.addNetworkStateListener((state) => {
    setOnline(!!state.isConnected);
  });
  return () => sub.remove();
});

function onAppStateChange(status: AppStateStatus) {
  if (Platform.OS !== "web") {
    focusManager.setFocused(status === "active");
  }
}

let appStateSub: { remove: () => void } | null = null;
export function startFocusManager() {
  if (appStateSub) return;
  appStateSub = AppState.addEventListener("change", onAppStateChange);
}
