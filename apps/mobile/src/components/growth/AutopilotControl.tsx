import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AUTOPILOT_OWNER_ONLY } from "../../features/growth/autopilot";
import { useSetAutopilot } from "../../features/growth/hooks";
import { track } from "../../lib/analytics";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { PillSwitch } from "../settings/SettingsUI";
import { AutopilotSheet } from "./AutopilotSheet";
import { TextLink } from "./StoryKit";

export function AutopilotControl({
  on,
  unavailable,
  canChange,
}: {
  on: boolean;
  unavailable: boolean;
  canChange: boolean;
}) {
  const styles = useStyles(makeStyles);
  const set = useSetAutopilot();
  const [open, setOpen] = useState(false);
  const [turningOn, setTurningOn] = useState(false);
  const [guarantee, setGuarantee] = useState(false);
  const disabled = unavailable || !canChange;
  const label = unavailable ? "Autopilot" : on ? "Autopilot on" : "Autopilot off";

  const close = () => {
    if (set.isPending) return;
    set.reset();
    setOpen(false);
  };
  const openSheet = () => {
    setTurningOn(!on);
    setOpen(true);
  };
  const confirm = () => {
    set.mutate(turningOn, {
      onSuccess: () => {
        track("growth_autopilot_changed", { on: turningOn });
        setOpen(false);
      },
    });
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={disabled ? undefined : openSheet}
        style={({ pressed }) => [styles.head, pressed && !disabled && styles.pressed, disabled && styles.disabled]}
        accessibilityRole="switch"
        accessibilityLabel="Autopilot"
        accessibilityState={{ checked: on, disabled }}
      >
        <Text style={styles.label}>{label}</Text>
        {unavailable ? <Text style={styles.meta}>Couldn't load this.</Text> : <PillSwitch value={on} />}
      </Pressable>
      {!unavailable && !canChange ? <Text style={styles.meta}>{AUTOPILOT_OWNER_ONLY}</Text> : null}
      <Text style={styles.meta}>
        Autopilot adjusts goals, pauses idle channels, checks in early. Spending, posts and code still ask you first.
      </Text>
      <TextLink label="Money-back guarantee" onPress={() => setGuarantee((v) => !v)} expanded={guarantee} />
      {guarantee ? (
        <Text style={styles.meta}>
          Each change Autopilot makes has a "This was a mistake" button. Mark it within 30 days and we undo the change and refund the credits it used. Daily or monthly credits that have reset since don't come back.
        </Text>
      ) : null}
      <AutopilotSheet
        open={open}
        turningOn={turningOn}
        saving={set.isPending}
        failed={set.isError}
        onCancel={close}
        onConfirm={confirm}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: 6, marginBottom: space.md },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, minHeight: 44 },
    label: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    meta: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.4 },
  });
