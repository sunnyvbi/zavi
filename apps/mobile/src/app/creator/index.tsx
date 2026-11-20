import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import {
  Card,
  CreatorScreen,
  DeadlineNote,
  Empty,
  ErrorNote,
  KeyValue,
  Loading,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
} from "../../components/creator/CreatorChrome";
import {
  useAcceptJob,
  useCreatorInbox,
  useMarkAlertRead,
  usePassJob,
} from "../../features/creator/hooks";
import { creatorLinkTarget } from "../../features/creator/phase";
import {
  day,
  jobTitle,
  money,
  type CreatorAlert,
  type CreatorJob,
} from "../../features/creator/api";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { friendlyError } from "../../components/ErrorCard";
import { FocusRing } from "../../components/ZaviTextField";

function errorText(e: unknown, fallback: string): string {
  return friendlyError(e, fallback);
}

function RequestCard({ job }: { job: CreatorJob }) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const accept = useAcceptJob();
  const pass = usePassJob();
  const [passing, setPassing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = accept.isPending || pass.isPending;

  return (
    <Card>
      <SectionTitle>
        {job.source === "applicant" ? "Hired from a brief" : "Booking request"}
      </SectionTitle>
      <Text style={styles.cardTitle}>{jobTitle(job)}</Text>

      <View style={styles.kvBlock}>
        <KeyValue label="Your price" value={money(job.price_cents)} strong />
        <KeyValue label="Zavi fee" value={money(job.creator_fee_cents)} />
        <KeyValue label="You receive" value={money(job.creator_payout_cents)} strong />
        {job.due_at ? <KeyValue label="Delivery date" value={day(job.due_at)} /> : null}
      </View>

      <DeadlineNote deadline={job.deadline} />
      <ErrorNote message={error} />

      {passing ? (
        <View style={styles.stack}>
          <Text style={styles.label}>Want to say why? Optional.</Text>
          <FocusRing radius={radius.sm}>
            {(focus) => (
              <TextInput
                keyboardAppearance={keyboardAppearance}
                multiline
                value={reason}
                onChangeText={setReason}
                placeholder="Booked that week, not the right fit, anything you like."
                placeholderTextColor={colors.muted}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                onFocus={focus.onFocus}
                onBlur={focus.onBlur}
                style={styles.input}
              />
            )}
          </FocusRing>
          <Text style={styles.hint}>
            The business sees this. You set your own price, so there is nothing to negotiate here.
          </Text>
          <PrimaryButton
            label={pass.isPending ? "Passing" : "Pass on this job"}
            disabled={busy}
            onPress={() => {
              setError(null);
              pass.mutate(
                { orderId: job.id, reason: reason.trim() },
                { onError: (e) => setError(errorText(e, "That did not go through. Try again.")) },
              );
            }}
          />
          <SecondaryButton label="Back" disabled={busy} onPress={() => setPassing(false)} />
        </View>
      ) : (
        <View style={styles.stack}>
          <PrimaryButton
            label={
              accept.isPending ? "Accepting" : `Accept for ${money(job.creator_payout_cents)}`
            }
            disabled={busy}
            onPress={() => {
              setError(null);
              accept.mutate(job.id, {
                onError: (e) => setError(errorText(e, "That did not go through. Try again.")),
              });
            }}
          />
          <SecondaryButton label="Pass" disabled={busy} onPress={() => setPassing(true)} />
        </View>
      )}
    </Card>
  );
}

function AlertRow({ alert }: { alert: CreatorAlert }) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const markRead = useMarkAlertRead();
  const unread = alert.read_at === null;
  const target = creatorLinkTarget(alert.link_path);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        if (unread) markRead.mutate(alert.id);
        if (target) router.push(target);
      }}
      style={[styles.alert, unread ? styles.alertUnread : null]}
    >
      <View style={styles.alertHead}>
        {unread ? <View style={styles.dot} /> : null}
        <Text style={styles.alertTitle}>{alert.title}</Text>
      </View>
      {alert.body ? <Text style={styles.alertBody}>{alert.body}</Text> : null}
    </Pressable>
  );
}

export default function CreatorInboxScreen() {
  const styles = useStyles(makeStyles);
  const { data, isPending, error } = useCreatorInbox();

  return (
    <CreatorScreen title="Inbox">
      {error ? (
        <ErrorNote message={errorText(error, "Your inbox did not load.")} />
      ) : isPending || !data ? (
        <Loading what="your inbox" />
      ) : (
        <>
          <SectionTitle>Waiting on you</SectionTitle>
          {data.requests.length === 0 ? (
            <Empty>
              No requests right now. Businesses find you from your page, and briefs that fit your
              lanes show up under Briefs.
            </Empty>
          ) : (
            data.requests.map((job) => <RequestCard key={job.id} job={job} />)
          )}

          <SectionTitle>Alerts</SectionTitle>
          {data.alerts.length === 0 ? (
            <Empty>Nothing yet. Zavi emails you as well, so you will not miss a booking.</Empty>
          ) : (
            <>
              {data.alerts.map((a) => (
                <AlertRow key={a.id} alert={a} />
              ))}
              <Text style={styles.hint}>{data.order}.</Text>
            </>
          )}
        </>
      )}
    </CreatorScreen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  cardTitle: { fontSize: font.size.lg, fontWeight: "700", color: colors.ink },
  kvBlock: { gap: space.xs },
  stack: { gap: space.sm },
  label: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
  hint: { fontSize: font.size.sm, lineHeight: 17, color: colors.muted },
  input: {
    fontFamily: font.family.medium,
    padding: space.md,
    fontSize: 15,
    color: colors.ink,
    minHeight: 72,
    textAlignVertical: "top",
  },
  alert: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    padding: space.md,
    gap: space.xs,
  },
  alertUnread: { backgroundColor: colors.soft },
  alertHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.ink },
  alertTitle: { fontSize: font.size.base, fontWeight: "700", color: colors.ink, flexShrink: 1 },
  alertBody: { fontSize: font.size.md, lineHeight: 19, color: colors.muted },
});
