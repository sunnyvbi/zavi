import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import {
  buildRunPanel,
  type RunPanel,
  type RunPanelGroup,
  type RunPanelStep,
  type RunPanelThought,
  type RunPanelTool,
} from "@zavi/shared";
import { Icon } from "./Icon";
import { ZaviGlance } from "./ZaviGlance";
import { useReduceMotion } from "../lib/motion";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export function RunProgress({
  status,
  panel,
  stopping,
}: {
  status: string | null | undefined;
  panel?: RunPanel;
  stopping?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const shown = panel ?? buildRunPanel([]);
  const line = stopping ? "Stopping…" : headline(shown.summary, status);

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.summary}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${line}. Show activity`}
      >
        {}
        <View style={styles.glance}>
          <ZaviGlance working />
        </View>
        <Shimmer style={styles.summaryText}>{line}</Shimmer>
        {}
        <View style={[styles.chevron, open && styles.chevronOpen]}>
          <Icon name="chevron" size={15} color={colors.muted} />
        </View>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {shown.items.map((item) =>
            item.type === "thought" ? (
              <Thought key={item.key} item={item} />
            ) : item.type === "group" ? (
              <Group key={item.key} item={item} />
            ) : (
              <Step key={item.key} item={item} />
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}

export function headline(summary: string, status: string | null | undefined): string {
  if (summary !== "Thinking…") return summary;
  return status === "running" ? "Zavi is working…" : "Waiting to start…";
}

function StateIcon({ state }: { state: RunPanelStep["state"] }) {
  const { colors } = useTheme();
  if (state === "running") return <Spinner />;
  return <Icon name="check" size={16} color={state === "failed" ? colors.run.failed : colors.muted} />;
}

function Thought({ item }: { item: RunPanelThought }) {
  const styles = useStyles(makeStyles);
  return <Text style={item.origin === "plan" ? styles.planThought : styles.thought}>{item.text}</Text>;
}

function Step({ item }: { item: RunPanelStep }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.step}>
      <StateIcon state={item.state} />
      {item.state === "running" ? (
        <Shimmer style={styles.stepText}>{item.label}</Shimmer>
      ) : (
        <Text style={styles.stepText}>{item.label}</Text>
      )}
    </View>
  );
}

function Group({ item }: { item: RunPanelGroup }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const label = item.count > 1 ? `${item.label} ×${item.count}` : item.label;
  return (
    <View style={styles.group}>
      <Pressable
        style={styles.groupHead}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}. Show details`}
      >
        <StateIcon state={item.state} />
        <Text style={styles.groupText} numberOfLines={1}>
          {label}
        </Text>
        <View style={open ? styles.chevronOpen : undefined}>
          <Icon name="chevron" size={13} color={colors.muted} />
        </View>
      </Pressable>
      {open ? item.tools.map((t) => <RawCall key={t.key} tool={t} />) : null}
    </View>
  );
}

function RawCall({ tool }: { tool: RunPanelTool }) {
  const styles = useStyles(makeStyles);
  const failed = tool.state === "failed";
  const detail = [tool.input ? `→ ${tool.input}` : "", tool.output ? `← ${tool.output}` : ""]
    .filter(Boolean)
    .join("\n");
  return (
    <View style={styles.tool}>
      <View style={styles.toolHead}>
        <Text style={styles.toolName} numberOfLines={1}>
          {tool.name}
        </Text>
        {tool.state !== "done" ? (
          <Text style={[styles.toolTag, failed && styles.toolTagFailed]}>
            {failed ? "failed" : "running"}
          </Text>
        ) : null}
      </View>
      {detail ? <Text style={styles.toolBody}>{detail}</Text> : null}
    </View>
  );
}

function Spinner() {
  const styles = useStyles(makeStyles);
  const reduceMotion = useReduceMotion();
  const turn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      turn.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, turn]);

  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      style={[styles.spinner, { transform: [{ rotate }] }]}
      importantForAccessibility="no"
      accessibilityElementsHidden
    />
  );
}

function Shimmer({ children, style }: { children: string; style: object }) {
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, pulse]);

  return (
    <Animated.Text style={[style, { opacity: pulse }]} numberOfLines={1}>
      {children}
    </Animated.Text>
  );
}

const mono = { fontFamily: "Menlo" as const };

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { marginTop: space.sm, marginBottom: 23 },
  summary: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 6 },
  glance: { transform: [{ translateY: -2 }] },
  summaryText: { flex: 1, fontSize: font.size.md, includeFontPadding: false, fontFamily: font.family.medium, color: colors.run.stepText },
  chevron: {},
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  body: { paddingLeft: 37, paddingTop: 4 },
  thought: { fontSize: font.size.md, lineHeight: 21, fontFamily: font.family.regular, color: colors.run.stepText, paddingVertical: 6 },
  planThought: { fontSize: font.size.sm, lineHeight: 18, fontFamily: font.family.regular, color: colors.run.toolTag, paddingVertical: 6 },
  group: { marginLeft: 10, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: colors.run.groupLine },
  groupHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  groupText: { flexShrink: 1, fontSize: font.size.sm, fontFamily: font.family.regular, color: colors.run.stepText },
  step: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: space.sm },
  stepText: { flex: 1, fontSize: font.size.md, includeFontPadding: false, fontFamily: font.family.regular, color: colors.run.stepText },
  tool: {
    borderWidth: 1,
    borderColor: colors.run.toolBorder,
    borderRadius: 9,
    backgroundColor: colors.run.toolBg,
    padding: 10,
    marginVertical: 4,
  },
  toolHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  toolName: { flex: 1, ...mono, fontSize: font.size.sm, color: colors.run.stepText },
  toolTag: { fontSize: font.size.sm, color: colors.run.toolTag },
  toolTagFailed: { color: colors.run.failed },
  toolBody: { ...mono, fontSize: font.size.sm, lineHeight: 17, color: colors.run.toolBody, marginTop: 6 },
  spinner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.spinnerTrack,
    borderTopColor: colors.spinnerHead,
    marginHorizontal: 1,
  },
});
