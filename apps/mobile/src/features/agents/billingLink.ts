import { useCallback } from "react";
import { Alert, Linking } from "react-native";
import { useRouter } from "expo-router";
import { isBillingEnabled, useSignupAvailability } from "../../auth/signup";
import { track } from "../../lib/analytics";
import { BILLING_URL } from "./creditWall";

export function useBillingEnabled(): boolean {
  return isBillingEnabled(useSignupAvailability().data);
}

export function useOpenBillingScreen(): (() => void) | null {
  const router = useRouter();
  const billingEnabled = useBillingEnabled();
  const open = useCallback(() => router.push("/settings/billing"), [router]);
  return billingEnabled ? open : null;
}

export function openBilling() {
  track("billing_opened");
  void Linking.openURL(BILLING_URL).catch(() =>
    Alert.alert("Couldn't open zaviagent.com", "Open zaviagent.com in your browser to manage billing."),
  );
}
