import { StyleSheet, Text, View } from "react-native";
import { AUTOPILOT_ERROR, autopilotCopy } from "../../features/growth/autopilot";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { AppBottomSheet } from "../AppBottomSheet";
import { ActionButton, ErrorLine } from "./StoryKit";

export function AutopilotSheet({
  open,
  turningOn,
  saving,
  failed,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  turningOn: boolean;
  saving: boolean;
  failed: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const styles = useStyles(makeStyles);
  const copy = autopilotCopy(turningOn);
  return (
    <AppBottomSheet open={open} onClose={onCancel} title={copy.title} locked={saving}>
      {copy.lists.map((list) => (
        <View key={list.title} style={styles.list}>
          <Text style={styles.listTitle}>{list.title}</Text>
          {list.items.map((item) => (
            <View key={item} style={styles.item}>
              <View style={styles.dot} />
              <Text style={styles.itemText}>{item}</Text>
            </View>
          ))}
        </View>
      ))}
      {copy.note ? <Text style={styles.note}>{copy.note}</Text> : null}
      {failed ? (
        <View style={styles.error}>
          <ErrorLine>{AUTOPILOT_ERROR}</ErrorLine>
        </View>
      ) : null}
      <View style={styles.actions}>
        <ActionButton label="Cancel" variant="secondary" grow disabled={saving} onPress={onCancel} />
        <ActionButton label={copy.confirmLabel} grow busy={saving} busyLabel="Saving…" onPress={onConfirm} />
      </View>
    </AppBottomSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { marginBottom: space.lg, gap: 6 },
    listTitle: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    item: { flexDirection: "row", gap: 10 },
    dot: { width: 5, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: colors.muted },
    itemText: { flex: 1, fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.textSecondary },
    note: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted, marginBottom: space.lg },
    error: { marginBottom: space.md },
    actions: { flexDirection: "row", gap: space.md, marginTop: space.sm },
  });
