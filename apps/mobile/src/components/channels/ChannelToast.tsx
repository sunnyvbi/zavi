import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useToast } from "../Toast";

export function useChannelToast() {
  const insets = useSafeAreaInsets();
  return useToast({ bottom: 155 + insets.bottom });
}

export function useSuccessToast() {
  const insets = useSafeAreaInsets();
  return useToast({ bottom: insets.bottom + 24 }, { fit: "content" });
}
