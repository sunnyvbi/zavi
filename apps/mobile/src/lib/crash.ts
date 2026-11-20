import { Platform } from "react-native";
import { getCrashlytics, recordError, setUserId } from "@react-native-firebase/crashlytics";

const crashlyticsOn = Platform.OS !== "web";

export function setCrashUser(id: string | null) {
  if (crashlyticsOn) void setUserId(getCrashlytics(), id ?? "");
}

export function reportError(error: Error) {
  if (crashlyticsOn) recordError(getCrashlytics(), error);
}
