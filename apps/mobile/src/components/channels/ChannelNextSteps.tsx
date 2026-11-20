import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "../Icon";
import { UnderlinedText } from "../UnderlinedText";
import { kindBuckets, kindPlural, onePerKind } from "../../features/channels/channelPage";
import type { ChannelAction } from "../../features/channels/types";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export type ExtraCard = { id: string; kind: string; node: ReactNode };

export function NextStepsSection({
  title = "Next steps",
  extra,
  extraPosition,
  actions,
  kindOf,
  renderAction,
  empty,
  grouped = true,
}: {
  title?: string;
  extra: ExtraCard[];
  extraPosition: "before" | "after";
  actions: ChannelAction[];
  kindOf: (a: ChannelAction) => string;
  renderAction: (a: ChannelAction) => ReactNode;
  empty: ReactNode;
  grouped?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(true);
  const [showAllExtra, setShowAllExtra] = useState(false);
  const [openKinds, setOpenKinds] = useState<ReadonlySet<string>>(new Set());

  const { shown, rest } = onePerKind(extra);
  const taken = new Set(shown.map((c) => c.kind));
  const buckets = kindBuckets(actions, kindOf);
  const total = actions.length + extra.length;

  function toggleKind(kind: string) {
    setOpenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  const extraNodes = (showAllExtra ? extra : shown).map((c) => <View key={c.id}>{c.node}</View>);

  return (
    <View>
      <Pressable
        style={styles.head}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${total}`}
      >
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{total}</Text>
        </View>
        <View style={open ? undefined : styles.closed}>
          <Icon name="chevron" size={20} color={colors.muted} />
        </View>
      </Pressable>
      {open ? (
        total === 0 ? (
          <View style={styles.empty}>{empty}</View>
        ) : (
          <View style={styles.list}>
            {extraPosition === "before" ? extraNodes : null}
            {!grouped ? actions.map((a) => <View key={a.id}>{renderAction(a)}</View>) : null}
            {(grouped ? buckets : []).map((b) => {
              const lead = taken.has(b.kind) ? 0 : 1;
              const isOpen = openKinds.has(b.kind);
              const visible = isOpen ? b.entries : b.entries.slice(0, lead);
              const held = b.entries.length - lead;
              return (
                <View key={b.kind} style={styles.kind}>
                  <View style={styles.kindHead}>
                    <Text style={styles.kindTitle}>{kindPlural(b.kind)}</Text>
                    <Text style={styles.kindCount}>{b.entries.length} open</Text>
                  </View>
                  {visible.map((a) => (
                    <View key={a.id}>{renderAction(a)}</View>
                  ))}
                  {held > 0 ? (
                    <Pressable style={styles.moreWrap} onPress={() => toggleKind(b.kind)} hitSlop={8} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}>
                      <UnderlinedText style={styles.more}>{isOpen ? "Show less" : `Show ${held} more ${kindPlural(b.kind).toLowerCase()}`}</UnderlinedText>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
            {extraPosition === "after" ? extraNodes : null}
            {rest.length > 0 ? (
              <Pressable style={styles.moreWrap} onPress={() => setShowAllExtra((v) => !v)} hitSlop={8} accessibilityRole="button" accessibilityState={{ expanded: showAllExtra }}>
                <UnderlinedText style={styles.more}>{showAllExtra ? "Show less" : `Show ${rest.length} more`}</UnderlinedText>
              </Pressable>
            ) : null}
          </View>
        )
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, marginTop: space.lg + space.xs },
    title: { fontFamily: font.family.semi, fontSize: 17, letterSpacing: -0.2, color: colors.ink },
    chip: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.soft },
    chipText: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    closed: { transform: [{ rotate: "-90deg" }] },
    list: { gap: space.md },
    kind: { gap: space.sm },
    kindHead: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
    kindTitle: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    kindCount: { fontFamily: font.family.medium, fontSize: 13, color: colors.muted },
    moreWrap: { alignSelf: "flex-start" },
    more: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    empty: { padding: space.md, borderWidth: 1, borderStyle: "dashed", borderColor: colors.line, borderRadius: radius.md },
  });
