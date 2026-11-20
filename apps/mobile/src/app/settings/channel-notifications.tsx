import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import {
  BackHeader,
  Intro,
  ListGroup,
  Message,
  PillSwitch,
  Row,
  SectionLabel,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import {
  CHANNEL_GROUPS,
  useChannelPrefs,
  useUpdateChannelPrefs,
} from "../../features/settings/api";
import {
  useNotificationSettings,
  usePushPermission,
  useUpdateNotificationSettings,
  type NotificationSettings,
  type PushPermission,
} from "../../features/notifications/hooks";
import { registerForPush } from "../../lib/push";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const PUSH_ROWS: {
  key: keyof NotificationSettings;
  label: string;
  help: string;
  fallback: boolean;
  newer?: boolean;
}[] = [
  { key: "agent_replies", label: "Zavi replies", help: "When Zavi answers you or finishes a task.", fallback: true },
  { key: "approvals", label: "Approvals", help: "When something needs your yes.", fallback: true },
  { key: "daily_brief", label: "Daily brief", help: "Your morning summary.", fallback: false },
  {
    key: "growth_lead",
    label: "Moves toward your goal",
    help: "When a move toward your goal waits for you on the Growth page.",
    fallback: true,
    newer: true,
  },
  {
    key: "result_milestone",
    label: "Results",
    help: "When you reach a goal or a number you track moves a lot.",
    fallback: true,
    newer: true,
  },
  {
    key: "connector_broke",
    label: "Connector problems",
    help: "When a connected tool stops working and needs you to reconnect.",
    fallback: true,
    newer: true,
  },
];

export default function ChannelNotifications() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const prefsQ = useChannelPrefs();
  const update = useUpdateChannelPrefs();
  const prefs = prefsQ.data ?? {};
  const pushQ = useNotificationSettings();
  const updatePush = useUpdateNotificationSettings();
  const push = pushQ.data;
  const { permission, refresh } = usePushPermission();
  const pushOff = permission === "ask" || permission === "blocked";

  const prevPermission = useRef<PushPermission>(permission);
  useEffect(() => {
    const prev = prevPermission.current;
    prevPermission.current = permission;
    if (permission === "granted" && (prev === "ask" || prev === "blocked")) {
      void registerForPush().catch(() => {});
    }
  }, [permission]);

  return (
    <Screen>
      <BackHeader title="Channel notifications" />
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
      >
        <Intro>Choose where Zavi reaches you. Push settings are just for you; Slack and email apply to everyone in this workspace.</Intro>

        <SectionLabel first>This phone · push</SectionLabel>
        {pushOff ? <PushOffCard permission={permission} onAllowed={refresh} /> : null}
        {pushQ.isLoading ? (
          <ActivityIndicator style={styles.loading} color={colors.muted} />
        ) : pushQ.isError ? (
          <Message tone="error">Couldn't load push settings.</Message>
        ) : (
          <>
            <ListGroup>
              {PUSH_ROWS.map((r) => {
                const on = push?.[r.key] ?? r.fallback;
                const notYet = !!r.newer && !(push && r.key in push);
                return (
                  <Row
                    key={r.key}
                    label={r.label}
                    sub={r.help}
                    role="switch"
                    state={{ checked: on, disabled: pushOff || notYet }}
                    accessibilityLabel={`Push ${r.label}`}
                    onPress={() => updatePush.mutate({ [r.key]: !on })}
                    trailing={<PillSwitch value={on} />}
                  />
                );
              })}
            </ListGroup>
            {PUSH_ROWS.some((r) => r.newer && !(push && r.key in push)) ? (
              <Text style={[styles.quiet, styles.notYet]}>
                Moves toward your goal, Results and Connector problems can be changed once Zavi starts sending them.
              </Text>
            ) : null}
          </>
        )}
        {updatePush.isError ? <Message tone="error">Couldn't save that change. Try again.</Message> : null}

        {prefsQ.isLoading ? (
          <ActivityIndicator style={styles.loading} color={colors.muted} />
        ) : prefsQ.isError ? (
          <Message tone="error">Couldn't load channel notifications. Go back and try again.</Message>
        ) : (
          CHANNEL_GROUPS.map((g) => (
            <View key={g.surface}>
              <SectionLabel>{`${g.surface} · ${g.dest}`}</SectionLabel>
              {g.rows.length > 0 ? (
                <ListGroup>
                  {g.rows.map((r) => {
                    const on = prefs[r.key] === true;
                    return (
                      <Row
                        key={r.key}
                        label={r.label}
                        sub={r.help}
                        role="switch"
                        state={{ checked: on }}
                        accessibilityLabel={`${g.surface} ${r.label}`}
                        onPress={() => update.mutate({ [r.key]: !on })}
                        trailing={<PillSwitch value={on} />}
                      />
                    );
                  })}
                </ListGroup>
              ) : null}
              {g.quiet ? <Text style={styles.quiet}>{g.quiet}</Text> : null}
            </View>
          ))
        )}
        {update.isError ? <Message tone="error">Couldn't save that change. Try again.</Message> : null}
      </ScrollView>
    </Screen>
  );
}

function PushOffCard({
  permission,
  onAllowed,
}: {
  permission: PushPermission;
  onAllowed: () => Promise<void>;
}) {
  const styles = useStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const blocked = permission === "blocked";

  const onPress = async () => {
    if (blocked) {
      void Linking.openSettings();
      return;
    }
    setBusy(true);
    try {
      await registerForPush();
    } catch {
    } finally {
      await onAllowed().catch(() => {});
      setBusy(false);
    }
  };

  return (
    <View style={styles.offCard}>
      <Text style={styles.offTitle}>Notifications are off for Zavi on this phone</Text>
      <Text style={styles.offSub}>
        Your switches are saved, but nothing reaches this phone until you turn them on.
      </Text>
      <Pressable
        style={({ pressed }) => [styles.offButton, (pressed || busy) && styles.offButtonPressed]}
        onPress={busy ? undefined : onPress}
        accessibilityRole="button"
        accessibilityState={{ busy }}
      >
        <Text style={styles.offButtonText}>{blocked ? "Open Settings" : "Turn on notifications"}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  loading: { marginTop: space.xl },
  quiet: { fontSize: font.size.sm, lineHeight: 18, color: colors.muted },
  notYet: { marginTop: space.sm },
  offCard: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    backgroundColor: colors.panel,
    padding: space.md,
    marginBottom: space.md,
  },
  offTitle: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  offSub: {
    marginTop: space.xs,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  offButton: {
    marginTop: space.md,
    minHeight: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  offButtonPressed: { opacity: 0.8 },
  offButtonText: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.onInk,
  },
});
