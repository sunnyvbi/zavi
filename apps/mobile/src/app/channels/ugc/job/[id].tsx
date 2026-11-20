import { useState } from "react";
import { Linking, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAvoider } from "../../../../components/KeyboardAvoider";
import { MediaViewer, inAppVideoAvailable, useVideoFrame, type MediaItem } from "../../../../components/MediaViewer";
import { SkeletonBlock } from "../../../../components/Skeleton";
import { useKeyboardReveal } from "../../../../components/useKeyboardReveal";
import { ErrorText, Note, ReadOnlyNote, StateLine, UgcButton, UgcScreen } from "../../../../components/channels/UgcParts";
import {
  JobActions,
  JobHeader,
  JobHistory,
  JobReceiptCard,
  JobVideoTile,
  NextAdLine,
  OrderedCard,
  PayControl,
  StatusLines,
  Stepper,
} from "../../../../components/channels/UgcJobParts";
import { ReviewBox } from "../../../../components/channels/UgcJobReview";
import { PublishCard } from "../../../../components/channels/UgcJobPublish";
import { previewNote, type Submission } from "../../../../features/channels/ugc";
import { useCanWrite, useCreatorCard, useJobDetail } from "../../../../features/channels/ugcHooks";
import {
  META_ADS_SLUG,
  NO_VIEW_LINK,
  bookAgain,
  creatorFirst,
  disputeNotice,
  jobSections,
  jobView,
  linkIsStale,
  nextAdLine,
  orderedLines,
  playMode,
  refreshesLive,
  screenTitle,
  videoTile,
} from "../../../../features/channels/ugcJob";
import { useFulfilPoll, useLiveRefetch } from "../../../../features/channels/ugcJobHooks";
import { CHANNELS_ENABLED } from "../../../../lib/flags";
import { radius, space, type Colors } from "../../../../theme/tokens";
import { useStyles, useTheme } from "../../../../theme/theme";

export default function JobRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Job />;
}

function Job() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const { id = "" } = useLocalSearchParams<{ id?: string }>();
  const q = useJobDetail(id);
  const canWrite = useCanWrite();
  const d = q.data;
  const job = d?.job;
  const card = useCreatorCard(job?.human_member_id ?? "");
  const pay = useFulfilPoll(id, job?.status === "checkout_pending", canWrite);
  useLiveRefetch(q.refetch, !!job && refreshesLive(job.status));
  const { scrollRef, onScroll, reveal } = useKeyboardReveal();
  const [refreshing, setRefreshing] = useState(false);
  const [preview, setPreview] = useState<MediaItem | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [fileError, setFileError] = useState<{ id: string; message: string } | null>(null);
  const tileFile = d && job ? videoTile(d, jobView(d, canWrite ? pay.state : "viewer"))?.file : undefined;
  const frame = useVideoFrame(tileFile?.kind === "video" ? tileFile.id : null, tileFile?.play_url ?? null);

  async function refresh() {
    setRefreshing(true);
    try {
      await q.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  async function openFile(file: Submission) {
    if (opening) return;
    setFileError(null);
    let fresh: Submission | undefined = file;
    if (!file.play_url || linkIsStale(q.dataUpdatedAt, Date.now())) {
      setOpening(file.id);
      const r = await q.refetch();
      setOpening(null);
      fresh = r.data?.submissions.find((s) => s.id === file.id);
    }
    const url = fresh?.play_url;
    if (!fresh || !url) {
      setFileError({ id: file.id, message: NO_VIEW_LINK });
      return;
    }
    const name = `Version ${fresh.version}${(fresh.position ?? 0) > 0 ? `, file ${(fresh.position ?? 0) + 1}` : ""}`;
    const mode = playMode(fresh.kind, inAppVideoAvailable());
    if (mode === "open") void Linking.openURL(url).catch(() => setFileError({ id: file.id, message: NO_VIEW_LINK }));
    else setPreview({ kind: mode, url, filename: name });
  }

  const openUrl = (url: string) => void Linking.openURL(url).catch(() => {});

  let content;
  if (!d || !job) {
    content = (
      <View>
        {q.isLoading ? (
          <JobSkeleton />
        ) : (
          <StateLine error={q.isError} onRetry={() => void q.refetch()} empty="This job isn't available." />
        )}
        {q.isError && q.error instanceof Error && q.error.message ? (
          <View style={styles.errorPad}>
            <ErrorText>{q.error.message}</ErrorText>
          </View>
        ) : null}
      </View>
    );
  } else {
    const first = creatorFirst(job);
    const view = jobView(d, canWrite ? pay.state : "viewer");
    const tile = videoTile(d, view);
    const sections = jobSections(d);
    const again = canWrite ? bookAgain(d) : null;
    const next = nextAdLine(d);
    const dispute = disputeNotice(d.dispute);
    content = (
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={32}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={colors.muted}
              colors={[colors.ink]}
              progressBackgroundColor={colors.surfaceRaised}
            />
          }
        >
          <JobHeader detail={d} view={view} photoUrl={card.data?.photo_url ?? null} />

          {tile ? (
            <JobVideoTile
              caption={tile.file.watermarked ? `Preview · ${tile.caption}` : tile.caption}
              frame={frame}
              busy={opening === tile.file.id}
              error={fileError?.id === tile.file.id ? fileError.message : null}
              hint={previewNote(tile.file)}
              onDownload={tile.file.download_url ? () => openUrl(tile.file.download_url ?? "") : undefined}
              onPress={() => void openFile(tile.file)}
            />
          ) : null}

          <View style={styles.card}>
            <Stepper status={job.status} closedReason={job.closed_reason} />
            <StatusLines view={view} />
            {canWrite ? (
              <PayControl detail={d} view={view} polling={pay.polling} restart={pay.restart} onFailed={() => void q.refetch()} />
            ) : job.status === "checkout_pending" ? (
              <ReadOnlyNote />
            ) : null}
            {again ? (
              <View style={styles.again}>
                <UgcButton
                  label={again.label}
                  onPress={() =>
                    again.pathname === "/channels/ugc/hire"
                      ? router.push({ pathname: "/channels/ugc/hire", params: again.params })
                      : router.push("/channels/ugc/find")
                  }
                />
              </View>
            ) : null}
            <JobActions detail={d} canWrite={canWrite} reveal={reveal} />
          </View>

          {dispute ? (
            <Note tone={dispute.tone} title={dispute.title}>
              {dispute.body}
            </Note>
          ) : null}

          {sections.review ? <ReviewBox orderId={job.id} first={first} canWrite={canWrite} reveal={reveal} /> : null}
          {sections.publish ? <PublishCard orderId={job.id} first={first} canWrite={canWrite} reveal={reveal} /> : null}

          <OrderedCard lines={orderedLines(d)} />

          {d.receipt ? <JobReceiptCard receipt={d.receipt} orderId={job.id} onOpen={openUrl} /> : null}

          <JobHistory detail={d} first={first} canWrite={canWrite} reveal={reveal} onSent={() => void q.refetch()} onOpenFile={(f) => void openFile(f)} />
          {fileError && fileError.id !== tile?.file.id ? <ErrorText>{fileError.message}</ErrorText> : null}

          {next ? (
            <NextAdLine rights={next.rights} onOpen={() => router.push({ pathname: "/channels/actions/[slug]", params: { slug: META_ADS_SLUG } })} />
          ) : null}

          {job.human_member_id ? (
            <UgcButton
              label={`Message ${first}`}
              variant="secondary"
              onPress={() => router.push({ pathname: "/channels/ugc/thread/[id]", params: { id: job.human_member_id ?? "" } })}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoider>
    );
  }

  return (
    <UgcScreen title={screenTitle(d)}>
      {content}
      <MediaViewer item={preview} onClose={() => setPreview(null)} />
    </UgcScreen>
  );
}

function JobSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.content} accessible accessibilityLabel="Loading job" accessibilityState={{ busy: true }}>
      <View style={styles.skeletonHead}>
        <SkeletonBlock width={56} height={56} radius={28} />
        <View style={styles.flex}>
          <SkeletonBlock width="80%" height={22} />
          <SkeletonBlock width="55%" height={14} style={styles.skeletonGap} />
        </View>
      </View>
      <SkeletonBlock width={170} height={26} radius={13} />
      {[64, 52, 96].map((h, i) => (
        <View key={i} style={styles.card}>
          <SkeletonBlock width="60%" height={18} />
          <SkeletonBlock height={h - 18} />
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    again: { marginTop: space.sm },
    errorPad: { paddingHorizontal: space.lg, paddingTop: space.sm, alignItems: "center" },
    skeletonHead: { flexDirection: "row", alignItems: "center", gap: space.md },
    skeletonGap: { marginTop: space.sm },
  });
