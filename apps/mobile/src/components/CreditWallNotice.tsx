import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { Icon } from "./Icon";
import { useCanManage } from "../features/settings/api";
import { useOpenBillingScreen } from "../features/agents/billingLink";
import { creditWallView, type CreditWall, type CreditWallKind } from "../features/agents/creditWall";
import { track } from "../lib/analytics";
import { font, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

function KindGlyph({ kind, color }: { kind: CreditWallKind; color: string }) {
  const stroke = { stroke: color, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      {kind === "credits" ? (
        <>
          <Path
            d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"
            {...stroke}
          />
          <Path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" {...stroke} />
        </>
      ) : null}
      {kind === "plan" ? (
        <>
          <Rect x={3} y={11} width={18} height={11} rx={2} ry={2} {...stroke} />
          <Path d="M7 11V7a5 5 0 0 1 10 0v4" {...stroke} />
        </>
      ) : null}
      {kind === "budget" ? (
        <>
          <Path d="m12 14 4-4" {...stroke} />
          <Path d="M3.34 19a10 10 0 1 1 17.32 0" {...stroke} />
        </>
      ) : null}
    </Svg>
  );
}

export function CreditWallNotice({ wall, onDismiss }: { wall: CreditWall; onDismiss: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const canManageBilling = useCanManage();
  const { text, action } = creditWallView(wall, { canManageBilling });
  const openBillingScreen = useOpenBillingScreen();
  const isCredits = wall.kind === "credits";

  useEffect(() => {
    track("credit_wall_shown");
  }, []);

  return (
    <View
      style={[styles.wrap, { borderColor: isCredits ? colors.status.amberLine : colors.wire.line }]}
      accessibilityRole="alert"
    >
      <View style={styles.row}>
        <View style={[styles.tile, { backgroundColor: isCredits ? colors.status.amberBg : colors.wire.tint }]}>
          <KindGlyph kind={wall.kind} color={isCredits ? colors.status.amberText : colors.wire.ink} />
        </View>
        <Text style={styles.text}>{text}</Text>
        <Pressable
          onPress={onDismiss}
          style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        >
          <Icon name="close" size={16} color={colors.wire.mute} strokeWidth={2} />
        </Pressable>
      </View>
      {action && openBillingScreen ? (
        <Pressable
          onPress={openBillingScreen}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Text style={styles.actionText}>
            {action}
            <Text style={styles.arrow}> ↗</Text>
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderRadius: 16,
    backgroundColor: colors.surfaceRaised,
    shadowColor: "#101214",
    shadowOpacity: 0.35,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 12 },
  },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  tile: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    flex: 1,
    paddingTop: 4,
    color: colors.wire.text,
    includeFontPadding: false,
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  closePressed: { backgroundColor: colors.wire.tint },
  action: {
    alignSelf: "flex-start",
    marginLeft: 42,
    height: 36,
    paddingHorizontal: 16,
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: colors.wire.ink,
  },
  actionText: {
    color: colors.onInk,
    includeFontPadding: false,
    fontFamily: font.family.semi,
    fontSize: 14,
  },
  arrow: { fontFamily: font.family.regular },
  pressed: { opacity: 0.7 },
});
