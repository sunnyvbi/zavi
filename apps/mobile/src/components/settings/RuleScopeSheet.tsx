import { forwardRef, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "../AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { useReduceMotion } from "../../lib/motion";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Option = { key: string; label: string };

export const RuleScopeSheet = forwardRef<
  BottomSheetModal,
  {
    value: string;
    agents: Option[];
    channels: Option[];
    onPick: (key: string) => void;
  }
>(function RuleScopeSheet({ value, agents, channels, onPick }, ref) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();

  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );

  function pick(key: string) {
    onPick(key);
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  }

  const row = (o: Option) => {
    const selected = o.key === value;
    return (
      <Pressable
        key={o.key}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => pick(o.key)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
      >
        <Text style={[styles.rowText, selected && styles.rowTextSelected]} numberOfLines={1}>
          {o.label}
        </Text>
        {selected ? <Icon name="tick" size={18} color={colors.status.tick} /> : null}
      </Pressable>
    );
  };

  const onSheetChange = useBackClosesSheet();
  return (
    <BottomSheetModal
      ref={ref}
      onChange={onSheetChange}
      snapPoints={["60%", "90%"]}
      enableDynamicSizing={false}
      enablePanDownToClose
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
      handleStyle={styles.handle}
      handleIndicatorStyle={styles.handleIndicator}
    >
      <BottomSheetScrollView contentContainerStyle={[styles.content, { paddingBottom: 20 + insets.bottom }]}>
        <Text style={styles.title}>Applies to</Text>
        <Text style={styles.sub}>Pick who follows this rule.</Text>
        <View style={styles.group}>{row({ key: "all", label: "All agents" })}</View>
        {agents.length > 0 ? (
          <>
            <Text style={styles.section}>One agent</Text>
            <View style={styles.group}>{agents.map(row)}</View>
          </>
        ) : null}
        <Text style={styles.section}>One channel</Text>
        <View style={styles.group}>{channels.map(row)}</View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBg: { backgroundColor: colors.surfaceRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  handle: { paddingTop: space.lg, paddingBottom: space.md },
  handleIndicator: { width: 36, height: 5, borderRadius: radius.pill, backgroundColor: colors.borderRaised },
  content: { paddingHorizontal: space.lg },
  title: { fontFamily: font.family.semi, fontSize: 20, lineHeight: 26, includeFontPadding: false, color: colors.ink },
  sub: {
    marginTop: 6,
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
    includeFontPadding: false,
    color: colors.textSecondary,
  },
  section: {
    marginTop: space.lg,
    marginBottom: space.sm,
    fontFamily: font.family.semi,
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: colors.muted,
  },
  group: {
    marginTop: space.sm,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.wire.line,
  },
  rowPressed: { backgroundColor: colors.soft },
  rowText: { flex: 1, fontFamily: font.family.regular, fontSize: 15, color: colors.ink },
  rowTextSelected: { fontFamily: font.family.semi },
});
