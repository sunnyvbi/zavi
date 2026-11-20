import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { font, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

export function friendlyError(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message.trim() : typeof e === "string" ? e.trim() : "";
  const status = (e as { status?: number } | null)?.status;
  const down =
    (typeof status === "number" && status >= 500) ||
    message.startsWith("{") ||
    /network request failed|failed to fetch/i.test(message);
  if (down) return "We couldn't reach Zavi right now. Please try again in a moment.";
  return message || fallback;
}

export function ErrorCard({ message, style }: { message: string; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.box, style]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  box: {
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: 12,
    backgroundColor: colors.errorBg,
  },
  text: {
    fontFamily: font.family.medium,
    includeFontPadding: false,
    color: colors.red,
    fontSize: 14,
    lineHeight: 20,
  },
});
