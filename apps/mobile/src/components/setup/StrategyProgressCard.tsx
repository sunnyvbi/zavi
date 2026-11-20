import { useEffect } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useIsFocused, useRouter } from "expo-router";
import { Icon } from "../Icon";
import { useSetup } from "../../features/setup/SetupProvider";
import { strategyCardState } from "../../features/setup/state";
import * as copy from "../../features/setup/copy";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const POLL_MS = 10_000;

export function StrategyProgressCard() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const focused = useIsFocused();
  const { state, canManage, refresh, mark } = useSetup();
  const card = strategyCardState(state, canManage);

  useEffect(() => {
    if (card !== "writing" || !focused) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [card, focused, refresh]);

  if (!card) return null;

  if (card === "writing") {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={colors.muted} />
        <View style={styles.text}>
          <Text style={styles.title}>{copy.STRATEGY_CARD_WRITING}</Text>
          <Text style={styles.detail}>{copy.STRATEGY_CARD_WRITING_DETAIL}</Text>
        </View>
      </View>
    );
  }

  const label = card === "ready" ? copy.STRATEGY_CARD_READY : copy.STRATEGY_CARD_FAILED;
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={() => {
        if (card === "ready") void mark({ step: "home" }).catch(() => {});
        router.push("/growth");
      }}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${copy.STRATEGY_CARD_OPEN}`}
    >
      <View style={[styles.dot, card === "ready" ? styles.dotReady : styles.dotFailed]} />
      <View style={styles.text}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.action}>{copy.STRATEGY_CARD_OPEN}</Text>
      </View>
      <View style={styles.chevronRight}>
        <Icon name="chevron" size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      marginTop: space.lg,
      marginHorizontal: space.lg,
      minHeight: 48,
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.lg,
      backgroundColor: colors.soft,
    },
    pressed: { opacity: 0.7 },
    text: { flex: 1, minWidth: 0 },
    title: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
    detail: { marginTop: 2, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    action: { marginTop: 2, fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    chevronRight: { transform: [{ rotate: "-90deg" }] },
    dot: { width: 8, height: 8, borderRadius: 4 },
    dotReady: { backgroundColor: colors.green },
    dotFailed: { backgroundColor: colors.red },
  });
