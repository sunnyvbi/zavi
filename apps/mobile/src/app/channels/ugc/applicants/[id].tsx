import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { showDialog } from "../../../../components/DialogHost";
import { UnderlinedText } from "../../../../components/UnderlinedText";
import { CreatorPhoto, CreatorSummaryBlock } from "../../../../components/channels/UgcHireParts";
import { Chip, ErrorText, Note, ReadOnlyNote, StateLine, UgcButton, UgcScreen } from "../../../../components/channels/UgcParts";
import {
  APPLICANTS_EMPTY,
  CLOSE_DIALOG,
  answerEveryoneCopy,
  applicantCard,
  applicantsLead,
  applicantsStatus,
  canAnswerEveryone,
  closedMessage,
  creatorSummary,
  type ApplicantView,
} from "../../../../features/channels/ugcHire";
import { useBriefApplicants, useCloseBrief, usePendingHires } from "../../../../features/channels/ugcHireHooks";
import { useCanWrite, useCreatorCard, useJobDetail } from "../../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../../lib/flags";
import { font, radius, space, type Colors } from "../../../../theme/tokens";
import { useStyles, useTheme } from "../../../../theme/theme";

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export default function ApplicantsRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Applicants />;
}

function Applicants() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const { id = "" } = useLocalSearchParams<{ id?: string }>();
  const canWrite = useCanWrite();
  const q = useBriefApplicants(id);
  const pending = usePendingHires();
  const close = useCloseBrief();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const d = q.data;

  const onPull = () => {
    setPulling(true);
    void Promise.all([q.refetch(), pending.refetch()]).finally(() => setPulling(false));
  };

  async function onClose() {
    if (close.isPending) return;
    const ok = await showDialog({ ...CLOSE_DIALOG });
    if (!ok) return;
    setError(null);
    setDone(null);
    close.mutate(id, {
      onSuccess: (r) => setDone(closedMessage(r)),
      onError: (e) => setError(message(e, "Couldn't close the brief. Try again.")),
    });
  }

  if (!d) {
    return (
      <UgcScreen title="Applicants">
        {}
        <StateLine loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()} />
      </UgcScreen>
    );
  }

  const status = applicantsStatus(d);
  const answer = answerEveryoneCopy(d.brief.answer_by);
  return (
    <UgcScreen title={`Applicants: ${d.brief.title ?? ""}`}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={colors.muted} colors={[colors.ink]} progressBackgroundColor={colors.surfaceRaised} />}
      >
        <Text style={styles.lead}>{applicantsLead(d)}</Text>

        <View style={styles.card}>
          <View style={styles.statusHead}>
            <Chip label={status.chip} tone={status.open ? "alert" : "soft"} />
            <Text style={styles.body}>{status.spots}</Text>
          </View>
          <Text style={styles.sub}>{status.answerBy}</Text>
          {status.closed ? <Text style={styles.sub}>{status.closed}</Text> : null}
          <Text style={styles.sub}>{status.order}</Text>
        </View>

        <Pressable
          style={({ pressed }) => [styles.linkWrap, pressed && styles.pressed]}
          onPress={() => router.push({ pathname: "/channels/ugc/brief/[id]", params: { id } })}
          hitSlop={6}
          accessibilityRole="link"
          accessibilityLabel="Read the published brief"
        >
          <UnderlinedText style={styles.link}>Read the published brief</UnderlinedText>
        </Pressable>

        {d.applicants.length === 0 ? (
          <Note>{APPLICANTS_EMPTY}</Note>
        ) : (
          d.applicants.map((a) => (
            <ApplicantItem
              key={a.application_id}
              a={a}
              briefId={id}
              briefOpen={d.brief.open}
              canWrite={canWrite}
              pendingOrderId={pending.data?.[a.application_id] ?? null}
              disabled={close.isPending}
            />
          ))
        )}

        {canAnswerEveryone(d, canWrite) ? (
          <View style={styles.card}>
            <Text style={styles.body}>{answer.lead}</Text>
            <Text style={styles.sub}>{answer.body}</Text>
            <ErrorText>{error}</ErrorText>
            <UgcButton label="Answer everyone and close" variant="secondary" busy={close.isPending} busyLabel="Sending" onPress={() => void onClose()} />
          </View>
        ) : null}
        {}
        {done ? <Note tone="ok">{done}</Note> : null}
        {!canWrite && d.applicants.length > 0 ? <ReadOnlyNote /> : null}
      </ScrollView>
    </UgcScreen>
  );
}

function ApplicantItem({
  a,
  briefId,
  briefOpen,
  canWrite,
  pendingOrderId,
  disabled,
}: {
  a: ApplicantView;
  briefId: string;
  briefOpen: boolean;
  canWrite: boolean;
  pendingOrderId: string | null;
  disabled: boolean;
}) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const card = useCreatorCard(a.human_member_id);
  const stored = useJobDetail(a.hire_state === "unpaid" && pendingOrderId ? pendingOrderId : "");
  const payable = stored.data?.job.status === "checkout_pending" ? pendingOrderId : null;
  const v = applicantCard(a, briefId, briefOpen, canWrite, payable);
  const go = (to: { pathname: string; params: Record<string, string> }) => router.push({ pathname: to.pathname as never, params: to.params });

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <CreatorPhoto name={a.display_name || "C"} url={card.data?.photo_url ?? null} />
        <View style={styles.headText}>
          <Text style={styles.name}>{v.name}</Text>
          {v.location ? <Text style={styles.sub}>{v.location}</Text> : null}
        </View>
        {v.price ? (
          <View style={styles.priceBox}>
            <Text style={styles.price}>{v.price}</Text>
            {v.youPay ? <Text style={styles.sub}>{v.youPay}</Text> : null}
          </View>
        ) : null}
      </View>
      <Text style={styles.body}>{v.note}</Text>
      {card.data ? <CreatorSummaryBlock s={creatorSummary(card.data)} /> : null}
      {v.outcome ? <Text style={styles.outcome}>{v.outcome}</Text> : null}
      {v.notBookable ? <Text style={styles.sub}>{v.notBookable}</Text> : null}
      <View style={styles.buttons}>
        {v.hire ? <UgcButton label={v.hire.label} disabled={disabled} onPress={() => go(v.hire!.to)} /> : null}
        {v.finishPaying ? <UgcButton label={v.finishPaying.label} disabled={disabled} onPress={() => go(v.finishPaying!.to)} /> : null}
        <UgcButton label={v.message.label} variant="secondary" onPress={() => go(v.message.to)} />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    lead: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 21, color: colors.textSecondary },
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    statusHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    name: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    priceBox: { alignItems: "flex-end", gap: 2 },
    price: { fontFamily: font.family.semi, fontSize: 20, lineHeight: 26, color: colors.ink },
    body: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 21, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
    outcome: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.muted },
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: 4 },
    linkWrap: { alignSelf: "flex-start" },
    link: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    pressed: { opacity: 0.7 },
  });
