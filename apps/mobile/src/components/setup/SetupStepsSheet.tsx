import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { AppBottomSheet } from "../AppBottomSheet";
import { Icon } from "../Icon";
import { PrimaryButton } from "../settings/SettingsUI";
import { SetupKnowsCard } from "./SetupKnowsCard";
import { useSetup } from "../../features/setup/SetupProvider";
import * as copy from "../../features/setup/copy";
import type { StepStatus } from "../../features/setup/types";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const BADGE = 30;

export function SetupStepsSheet({
  open,
  onClose,
  shown,
  statuses,
}: {
  open: boolean;
  onClose: () => void;
  shown: 1 | 2 | 3;
  statuses: [StepStatus, StepStatus, StepStatus];
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const files = useSetup().imports.files;
  const noFiles = Array.isArray(files) && files.length === 0;

  return (
    <AppBottomSheet
      open={open}
      onClose={onClose}
      title={copy.STEPS_SHEET_TITLE}
    >
      <Text style={styles.body}>{copy.STEPS_SHEET_BODY}</Text>
      <View>
        {copy.STEP_TITLES.map((title, i) => {
          const n = i + 1;
          const status = i === 0 && noFiles && statuses[i] === "done" ? "skipped" : statuses[i];
          const current = n === shown;
          const statusLine =
            status === "done" ? copy.RAIL_DONE : status === "skipped" ? copy.RAIL_SKIPPED : current ? copy.RAIL_NOW : copy.RAIL_LATER;
          return (
            <View key={title} style={[styles.row, current && styles.rowCurrent, i > 0 && styles.rowAfter]}>
              <View
                style={[
                  styles.badge,
                  status === "done"
                    ? styles.badgeDone
                    : status === "skipped"
                      ? null
                      : current
                        ? styles.badgeCurrent
                        : styles.badgeLater,
                ]}
              >
                {}
                {status === "skipped" ? (
                  <Svg width={BADGE} height={BADGE} style={StyleSheet.absoluteFill}>
                    <Circle
                      cx={BADGE / 2}
                      cy={BADGE / 2}
                      r={(BADGE - 1) / 2}
                      stroke={colors.muted}
                      strokeWidth={1}
                      strokeDasharray="2 2.5"
                      fill="none"
                    />
                  </Svg>
                ) : null}
                {status === "done" ? (
                  <Icon name="tick" size={16} color={colors.onInk} strokeWidth={2.5} />
                ) : (
                  <Text
                    style={[
                      styles.number,
                      status === "skipped" ? styles.numberSkipped : current ? styles.numberCurrent : styles.numberLater,
                    ]}
                  >
                    {n}
                  </Text>
                )}
              </View>
              <View style={styles.textCol}>
                <Text style={styles.name}>{title}</Text>
                <Text style={styles.status} numberOfLines={1}>
                  {statusLine}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
      <SetupKnowsCard />
      <View style={styles.divider} />
      <PrimaryButton label={copy.STEPS_SHEET_OK} onPress={onClose} style={styles.okButton} />
    </AppBottomSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: {
      marginTop: -space.sm,
      marginBottom: space.md,
      fontFamily: font.family.regular,
      fontSize: 14,
      lineHeight: 20,
      color: colors.textSecondary,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      padding: radius.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: "transparent",
    },
    rowCurrent: { borderColor: colors.line, backgroundColor: colors.surfaceRaised },
    rowAfter: { marginTop: 2 },
    badge: {
      width: BADGE,
      height: BADGE,
      borderRadius: radius.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    badgeDone: { backgroundColor: colors.ink },
    badgeCurrent: { borderWidth: 1, borderColor: colors.ink },
    badgeLater: { borderWidth: 1, borderColor: colors.line },
    number: { fontFamily: font.family.semi, fontSize: 15, lineHeight: 20 },
    numberSkipped: { color: colors.muted },
    numberCurrent: { color: colors.ink },
    numberLater: { color: colors.textSecondary },
    textCol: { flex: 1 },
    name: { fontFamily: font.family.semi, fontSize: 15, lineHeight: 20, color: colors.ink },
    status: { marginTop: 2, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    divider: { height: 1, marginHorizontal: -space.lg, marginTop: space.lg, backgroundColor: colors.line },
    okButton: { marginTop: space.md, minHeight: 48, borderRadius: radius.md },
  });
