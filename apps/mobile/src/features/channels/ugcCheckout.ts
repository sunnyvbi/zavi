import { Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";

export const CHECKOUT_RETURN_HINT = "Payment by Stripe. Zavi never sees your card number. After paying, tap Done to come back to Zavi.";

export async function openCheckout(url: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: "done" });
  } catch {
    await Linking.openURL(url).catch(() => {});
  }
}
