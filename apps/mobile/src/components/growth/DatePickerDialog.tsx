import { useEffect, useMemo, useState } from "react";
import { Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { addMonths, dateLabel, isoOf, monthWeeks, parseIsoDate } from "../../features/growth/dates";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Icon } from "../Icon";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function today() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function startMonth(value: string) {
  const p = parseIsoDate(value);
  if (p) return { year: p.year, month: p.month };
  const t = today();
  return { year: t.year, month: t.month };
}

function Arrow({ label, rotate, onPress }: { label: string; rotate: "left" | "right"; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.arrow, pressed && styles.arrowPressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={{ transform: [{ rotate: rotate === "left" ? "90deg" : "-90deg" }] }}>
        <Icon name="chevron" size={20} color={colors.ink} />
      </View>
    </Pressable>
  );
}

export function DatePickerDialog({
  visible,
  value,
  onSelect,
  onClose,
}: {
  visible: boolean;
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const styles = useStyles(makeStyles);
  const [shown, setShown] = useState(startMonth(value));
  const selected = parseIsoDate(value);
  const now = today();
  const cardWidth = Math.min(340, Dimensions.get("window").width - 40);

  useEffect(() => {
    if (visible) setShown(startMonth(value));
  }, [visible, value]);

  const weeks = useMemo(() => monthWeeks(shown.year, shown.month), [shown.year, shown.month]);
  const move = (delta: number) => setShown(addMonths(shown.year, shown.month, delta));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <ScrollView style={styles.backdrop} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close date picker" />
        <View style={[styles.card, { width: cardWidth }]} accessibilityViewIsModal>
          <View style={styles.header}>
            <Arrow label="Previous month" rotate="left" onPress={() => move(-1)} />
            <Text style={styles.title} accessibilityRole="header">
              {MONTHS[shown.month - 1]} {shown.year}
            </Text>
            <Arrow label="Next month" rotate="right" onPress={() => move(1)} />
          </View>
          <View style={styles.weekRow}>
            {WEEKDAYS.map((d, i) => (
              <Text key={`${d}${i}`} style={styles.weekday}>
                {d}
              </Text>
            ))}
          </View>
          {weeks.map((week, wi) => (
            <View key={wi} style={styles.week}>
              {week.map((day, di) => {
                const iso = day === null ? "" : isoOf(shown.year, shown.month, day);
                const isSelected = day !== null && selected !== null && selected.year === shown.year && selected.month === shown.month && selected.day === day;
                const isToday = day !== null && now.year === shown.year && now.month === shown.month && now.day === day;
                return (
                  <View key={`${wi}-${di}`} style={styles.slot}>
                    {day === null ? null : (
                      <Pressable
                        onPress={() => {
                          onSelect(iso);
                          onClose();
                        }}
                        style={({ pressed }) => [styles.day, isToday && styles.today, isSelected && styles.selected, pressed && !isSelected && styles.dayPressed]}
                        accessibilityRole="button"
                        accessibilityLabel={dateLabel(iso)}
                        accessibilityState={{ selected: isSelected }}
                      >
                        <Text style={[styles.dayText, isSelected && styles.selectedText]}>{day}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
          <Pressable onPress={onClose} style={({ pressed }) => [styles.cancel, pressed && styles.arrowPressed]} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: colors.scrim },
    container: { flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 20 },
    card: { alignSelf: "center", backgroundColor: colors.surfaceRaised, borderRadius: radius.lg + 1, padding: 18 },
    header: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    arrow: { width: 40, height: 40, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    arrowPressed: { backgroundColor: colors.soft },
    title: { flex: 1, fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, includeFontPadding: false, color: colors.ink, textAlign: "center" },
    weekRow: { marginTop: space.md, flexDirection: "row" },
    weekday: { width: 40, fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted, textAlign: "center" },
    week: { flexDirection: "row" },
    slot: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    day: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
    today: { borderWidth: 1, borderColor: colors.ink },
    selected: { backgroundColor: colors.ink, borderColor: colors.ink },
    dayPressed: { backgroundColor: colors.soft },
    dayText: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    selectedText: { color: colors.onInk },
    cancel: { marginTop: 8, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 8 },
    cancelText: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
  });
