import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";

export function useAppleSignInAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let canceled = false;
    AppleAuthentication.isAvailableAsync()
      .then((ok) => {
        if (!canceled) setAvailable(ok);
      })
      .catch((e) => {
        if (__DEV__) {
          console.warn("[apple-auth] isAvailableAsync failed:", e);
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  return available;
}
