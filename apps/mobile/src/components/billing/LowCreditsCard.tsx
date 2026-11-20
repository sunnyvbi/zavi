import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { openBilling } from "../../features/agents/billingLink";
import type { Credits } from "../../features/settings/api";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
const EXTERNAL_PATH = "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5";

export function ExternalIcon({ color, strokeWidth }: { color: string; strokeWidth: number }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
      <Path
        d={EXTERNAL_PATH}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

export function LowCreditsCard({
  c,
  showLinks,
  canManage = false,
}: {
  c: Credits;
  showLinks: boolean;
  canManage?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  if (c.unlimited) return null;
  const low = c.soft_warn;

  return (
    <View style={[styles.card, low && styles.cardLow]}>
      <Text style={styles.title}>{low ? "Credits are running low" : "Need more credits?"}</Text>
      <Text style={styles.body}>
        {low
          ? "Zavi pauses when credits run out. Upgrade your plan or buy a one-time pack."
          : "Upgrade your plan, or buy a one-time credit pack."}
      </Text>

      {showLinks ? (
        <View style={styles.buttons}>
          <Pressable
            style={({ pressed }) => [styles.button, styles.buttonLight, pressed && styles.pressed]}
            onPress={openBilling}
            accessibilityRole="button"
          >
            <Text style={[styles.buttonText, styles.textDark]}>Buy a credit pack</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.button, styles.buttonDark, pressed && styles.pressed]}
            onPress={openBilling}
            accessibilityRole="button"
          >
            <Text style={[styles.buttonText, styles.textWhite]}>Change plan</Text>
            <ExternalIcon color={colors.onInk} strokeWidth={2} />
          </Pressable>
        </View>
      ) : (
        <View style={styles.note}>
          <Svg width={14} height={14} viewBox="0 0 24 24" style={styles.noteIcon}>
            <Rect
              x={4}
              y={11}
              width={16}
              height={10}
              rx={2}
              stroke={colors.wire.mute}
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <Path
              d="M8 11V7a4 4 0 0 1 8 0v4"
              stroke={colors.wire.mute}
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </Svg>
          <Text style={styles.lockText}>
            {canManage
              ? "Plans and credits are bought on zaviagent.com. Open it in a browser to change them."
              : "Only owners and admins can change the plan or buy credits. Ask your workspace owner."}
          </Text>
        </View>
      )}
    </View>
  );
}

export function BillingNote({ showLinks: _showLinks }: { showLinks: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.footer}>
      <View style={styles.noteIcon}>
        <ExternalIcon color={colors.wire.mute} strokeWidth={1.9} />
      </View>
      <Text style={styles.footerText}>
        The app takes no payment. Buttons that buy open zaviagent.com, and your balance here updates
        when you come back.
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.wire.line, borderRadius: 16, backgroundColor: colors.wire.card, padding: 16 },
  cardLow: { borderColor: colors.status.amberLine, backgroundColor: colors.status.amberBg },
  title: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.ink },
  body: { marginTop: 4, fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.wire.sub },
  buttons: { marginTop: 12, flexDirection: "row", gap: 8 },
  button: {
    flex: 1,
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 999,
  },
  buttonLight: { borderWidth: 1, borderColor: colors.wire.line, backgroundColor: colors.bg },
  buttonDark: { backgroundColor: colors.wire.ink },
  buttonText: { fontFamily: font.family.semi, fontSize: 14 },
  textDark: { color: colors.wire.text },
  textWhite: { color: colors.onInk },
  pressed: { opacity: 0.8 },
  note: { marginTop: 10, flexDirection: "row", alignItems: "flex-start", gap: 6 },
  noteIcon: { marginTop: 2 },
  lockText: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.wire.mute },
  footer: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  footerText: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.wire.mute },
});
