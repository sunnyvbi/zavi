import React, { createContext, useContext } from "react";
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { useKeyboardReveal, type Revealable } from "../useKeyboardReveal";
import { layout, type, PHASES, TOTAL_STEPS } from "./design";
import { ErrorCard } from "../ErrorCard";
import { KeyboardAvoider } from "../KeyboardAvoider";
import { BackIcon } from "../Icon";

const RevealContext = createContext<((target: Revealable | null) => void) | null>(null);

export function useRevealOnFocus() {
  return useContext(RevealContext);
}

type Props = {
  step: number;
  onBack?: () => void;
  hideBack?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  phaseLabel?: string;
  fill?: boolean;
  bare?: boolean;
};

export function Shell({ step, onBack, hideBack, children, footer, phaseLabel, fill, bare }: Props) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const phase = phaseLabel ?? PHASES[Math.min(Math.max(step, 1), TOTAL_STEPS) - 1];

  const { keyboardOpen, scrollRef, onScroll, reveal } = useKeyboardReveal();

  return (
    <RevealContext.Provider value={reveal}>
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <KeyboardAvoider style={styles.flex}>
          {bare ? null : (
          <>
          {}
          <View style={styles.nav}>
            {hideBack ? (
              <View style={styles.backSpacer} />
            ) : (
              <Pressable
                style={styles.back}
                onPress={onBack}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Back"
              >
                <BackIcon />
              </Pressable>
            )}
            {}
            <View style={styles.phaseBox}>
              <Text style={styles.count}>{`${String(Math.min(Math.max(step, 1), TOTAL_STEPS)).padStart(2, "0")} / ${String(TOTAL_STEPS).padStart(2, "0")}`}</Text>
              <Text style={styles.phase}>{phase}</Text>
            </View>
          </View>

          {}
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityLabel="Setup progress"
            accessibilityValue={{ min: 0, max: TOTAL_STEPS, now: step }}
          >
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <View key={i} style={[styles.segment, i < step && styles.segmentOn]} />
            ))}
          </View>
          </>
          )}

          <ScrollView
            ref={scrollRef}
            style={styles.flex}
            contentContainerStyle={[styles.body, fill && styles.fill]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
          >
            <Pressable style={styles.flex} onPress={Keyboard.dismiss} accessible={false}>
              {children}
            </Pressable>
          </ScrollView>

          {}
          {footer ? (
            <View
              style={[
                styles.footer,
                { paddingBottom: layout.footerPaddingBottom + (keyboardOpen ? 0 : insets.bottom) },
              ]}
            >
              {footer}
            </View>
          ) : null}
        </KeyboardAvoider>
      </SafeAreaView>
    </RevealContext.Provider>
  );
}

export function Heading({
  title,
  sub,
  center,
}: {
  title: string;
  sub?: string;
  center?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <>
      <Text style={[styles.h1, center && styles.centered]} accessibilityRole="header">
        {title}
      </Text>
      {sub ? <Text style={[styles.sub, center && styles.centered]}>{sub}</Text> : null}
    </>
  );
}

export function ErrorLine({ message }: { message?: string | null }) {
  if (!message) return null;
  return <ErrorCard message={message} />;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  nav: {
    height: layout.navHeight,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: layout.navPaddingH,
    gap: 12,
  },
  back: {
    width: layout.backSize,
    height: layout.backSize,
    borderRadius: layout.backSize / 2,
    backgroundColor: colors.form.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  backSpacer: { width: layout.backSize, height: layout.backSize },
  phaseBox: { alignItems: "flex-end" },
  count: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 13,
    letterSpacing: 0.4,
    fontVariant: ["tabular-nums"],
    color: colors.form.placeholder,
  },
  phase: {
    marginTop: 5,
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.ink,
  },
  track: {
    flexDirection: "row",
    gap: layout.trackGap,
    paddingHorizontal: layout.trackPaddingH,
    paddingBottom: 10,
  },
  segment: {
    flex: 1,
    height: layout.trackHeight,
    borderRadius: 4,
    backgroundColor: colors.form.edge,
  },
  segmentOn: { backgroundColor: colors.ink },
  fill: { flexGrow: 1 },
  body: {
    paddingHorizontal: layout.bodyPaddingH,
    paddingTop: layout.bodyPaddingTop,
    paddingBottom: layout.bodyPaddingBottom,
  },
  h1: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: type.h1Size,
    lineHeight: type.h1Line,
    letterSpacing: type.h1Spacing,
    color: colors.ink,
    marginBottom: 13,
  },
  sub: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: type.subSize,
    lineHeight: type.subLine,
    color: colors.form.soft,
    marginBottom: 24,
  },
  centered: { textAlign: "center" },
  footer: {
    paddingHorizontal: layout.footerPaddingH,
    paddingTop: layout.footerPaddingTop,
    backgroundColor: colors.bg,
  },
});
