import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import type { ArtifactFilter } from "../../features/artifacts/types";

export const ARTIFACT_FILTERS: readonly { value: ArtifactFilter; label: string }[] = [
  { value: "all", label: "All Artifacts" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "website", label: "Websites & Apps" },
  { value: "presentation", label: "Slides" },
  { value: "dashboard", label: "Dashboards" },
  { value: "spreadsheet", label: "Sheets" },
  { value: "document", label: "Reports" },
  { value: "file", label: "Other Files" },
];

export function ArtifactFilterPills({
  value,
  onChange,
}: {
  value: ArtifactFilter;
  onChange: (value: ArtifactFilter) => void;
}) {
  const styles = useStyles(makeStyles);
  const scroller = useRef<ScrollView>(null);
  const layouts = useRef<Record<string, { x: number; w: number }>>({});
  const offset = useRef(0);
  const viewport = useRef(0);

  const reveal = (key: string) => {
    const box = layouts.current[key];
    if (!box || viewport.current === 0) return;
    const pad = space.lg;
    const left = box.x - pad;
    const right = box.x + box.w + pad;
    if (left < offset.current) scroller.current?.scrollTo({ x: Math.max(0, left), animated: true });
    else if (right > offset.current + viewport.current) scroller.current?.scrollTo({ x: right - viewport.current, animated: true });
  };

  useEffect(() => {
    reveal(value);
  }, [value]);

  return (
    <ScrollView
      ref={scroller}
      horizontal
      style={styles.scroll}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      scrollEventThrottle={16}
      onScroll={(e) => {
        offset.current = e.nativeEvent.contentOffset.x;
      }}
      onLayout={(e) => {
        viewport.current = e.nativeEvent.layout.width;
        reveal(value);
      }}
      accessibilityLabel="Artifact types"
    >
      {ARTIFACT_FILTERS.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            style={[styles.pill, selected && styles.pillSelected]}
            onLayout={(e) => {
              layouts.current[option.value] = { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width };
            }}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
          >
            <Text style={[styles.label, selected && styles.labelSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scroll: { flexGrow: 0, height: 58 },
  content: {
    gap: space.xs,
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  pill: {
    minHeight: 42,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.panel,
  },
  pillSelected: { backgroundColor: colors.ink },
  label: {
    fontFamily: font.family.medium,
    fontSize: 13,
    lineHeight: 17,
    textAlignVertical: "center",
    includeFontPadding: false,
    color: colors.muted,
  },
  labelSelected: { includeFontPadding: false, fontFamily: font.family.semi, color: colors.onInk },
});
