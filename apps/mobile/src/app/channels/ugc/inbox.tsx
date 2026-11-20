import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { Redirect, useRouter } from "expo-router";
import { AppBottomSheet } from "../../../components/AppBottomSheet";
import { UnderlinedText } from "../../../components/UnderlinedText";
import { CreatorAvatar, StateLine, UgcButton, UgcScreen } from "../../../components/channels/UgcParts";
import { ToneChip } from "../../../components/channels/UgcParts";
import { firstName } from "../../../features/channels/ugc";
import {
  INBOX_FILTERS,
  NO_MESSAGES,
  filterCounts,
  inboxScreen,
  inboxSubLine,
  laneTone,
  lastMessage,
  reviewJob,
  type CreatorEntry,
  type InboxFilterKey,
  type InboxJob,
} from "../../../features/channels/ugcInbox";
import { useCreatorInbox } from "../../../features/channels/ugcInboxHooks";
import { useCanWrite, useCreatorCard, useMarkNoticesRead } from "../../../features/channels/ugcHooks";
import { CHANNELS_ENABLED } from "../../../lib/flags";
import { font, radius, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";

const INTRO = "Everyone you have messaged or booked, with their jobs. Message, review and follow up from here.";
const JOBS_SHOWN = 3;

export default function InboxRoute() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <Inbox />;
}

function Inbox() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const inbox = useCreatorInbox();
  const [pulling, setPulling] = useState(false);
  const onPull = () => {
    setPulling(true);
    void inbox.refetch().finally(() => setPulling(false));
  };
  const mark = useMarkNoticesRead();
  const canWrite = useCanWrite();
  const [filter, setFilter] = useState<InboxFilterKey>("all");
  const view = inboxScreen(inbox.entries, inbox.error, filter);
  const counts = inbox.entries ? filterCounts(inbox.entries) : null;

  function go(e: CreatorEntry, to: { job: string } | { thread: string }) {
    if (e.unread.length && canWrite) mark.mutate(e.unread);
    if ("job" in to) router.push({ pathname: "/channels/ugc/job/[id]", params: { id: to.job } });
    else router.push({ pathname: "/channels/ugc/thread/[id]", params: { id: to.thread } });
  }

  return (
    <UgcScreen title="Creators">
      <FlatList
        data={view.kind === "list" ? view.shown : []}
        keyExtractor={(e) => e.memberId}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={colors.muted} colors={[colors.ink]} progressBackgroundColor={colors.surfaceRaised} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.intro}>{INTRO}</Text>
            {counts && inbox.entries && inbox.entries.length > 0 ? (
              <View style={styles.filters} accessibilityRole="tablist">
                {INBOX_FILTERS.map((f) => {
                  const on = filter === f.key;
                  return (
                    <Pressable
                      key={f.key}
                      style={({ pressed }) => [styles.filter, on && styles.filterOn, pressed && styles.pressed]}
                      onPress={() => setFilter(f.key)}
                      accessibilityRole="tab"
                      accessibilityLabel={`${f.label}, ${counts[f.key]}`}
                      accessibilityState={{ selected: on }}
                    >
                      <Text style={[styles.filterText, on && styles.filterTextOn]}>{f.label}</Text>
                      <Text style={[styles.filterCount, on && styles.filterCountOn]}>{counts[f.key]}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {view.banner ? (
              <View style={styles.banner} accessibilityRole="alert">
                <Text style={styles.bannerText}>{view.banner}</Text>
                {!inbox.entries ? (
                  <View style={styles.bannerAction}>
                    <UgcButton label="Try again" variant="secondary" onPress={inbox.refetch} />
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          view.kind === "loading" ? (
            <StateLine loading />
          ) : view.kind === "empty" && view.text ? (
            <Text style={styles.note}>{view.text}</Text>
          ) : null
        }
        renderItem={({ item }) => <InboxCard entry={item} go={go} />}
      />
    </UgcScreen>
  );
}

function InboxAvatar({ memberId, name }: { memberId: string; name: string }) {
  const styles = useStyles(makeStyles);
  const photo = useCreatorCard(memberId).data?.photo_url ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  if (!photo || failed === photo) return <CreatorAvatar name={name} />;
  return (
    <View style={styles.photo}>
      <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} contentFit="cover" onError={() => setFailed(photo)} accessibilityLabel={`${name}'s photo`} />
    </View>
  );
}

function InboxCard({ entry: e, go }: { entry: CreatorEntry; go: (e: CreatorEntry, to: { job: string } | { thread: string }) => void }) {
  const styles = useStyles(makeStyles);
  const first = firstName(e.name);
  const last = lastMessage(e);
  const review = reviewJob(e);
  const [allJobs, setAllJobs] = useState(false);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <InboxAvatar memberId={e.memberId} name={e.name} />
        <View style={styles.headText}>
          <View style={styles.nameRow}>
            <Text style={styles.name}>{e.name}</Text>
            {e.unread.length > 0 ? (
              <View style={styles.newTag} accessibilityLabel="New">
                <View style={styles.newDot} />
                <Text style={styles.newText}>New</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.sub}>{inboxSubLine(e)}</Text>
          {last ? (
            <Text style={styles.last} numberOfLines={2}>
              <Text style={styles.lastWho}>{last.who}</Text> {last.body}
              {last.stamp ? <Text style={styles.stamp}>{` · ${last.stamp}`}</Text> : null}
            </Text>
          ) : (
            <Text style={styles.sub}>{NO_MESSAGES}</Text>
          )}
        </View>
      </View>
      {e.jobs.length > 0 ? (
        <View style={styles.jobs}>
          {e.jobs.slice(0, JOBS_SHOWN).map((j) => (
            <JobRow key={j.job.id} item={j} onPress={() => go(e, { job: j.job.id })} />
          ))}
          {e.jobs.length > JOBS_SHOWN ? (
            <Pressable
              style={({ pressed }) => [styles.more, pressed && styles.pressed]}
              onPress={() => setAllJobs(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Show all ${e.jobs.length} jobs with ${first}`}
            >
              <UnderlinedText style={styles.moreText}>Show more</UnderlinedText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={styles.buttons}>
        {review ? <UgcButton label="Review delivery" onPress={() => go(e, { job: review.job.id })} /> : null}
        <UgcButton label={`Message ${first}`} variant="secondary" onPress={() => go(e, { thread: e.memberId })} />
      </View>
      <AppBottomSheet open={allJobs} onClose={() => setAllJobs(false)} title={`Jobs with ${first}`}>
        <View style={styles.sheetJobs}>
          {e.jobs.map((j) => (
            <JobRow
              key={j.job.id}
              item={j}
              onPress={() => {
                setAllJobs(false);
                go(e, { job: j.job.id });
              }}
            />
          ))}
        </View>
      </AppBottomSheet>
    </View>
  );
}

function JobRow({ item: { job, row }, onPress }: { item: InboxJob; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [styles.jobRow, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${job.title}, ${row.status}`}
    >
      <View style={styles.jobText}>
        <Text style={styles.jobTitle} numberOfLines={1}>
          {job.title}
        </Text>
        {row.line ? <Text style={styles.jobLine}>{row.line}</Text> : null}
      </View>
      <ToneChip label={row.status} tone={laneTone(row.tone)} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    header: { gap: space.md },
    intro: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    filters: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    filter: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
    filterOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    filterText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    filterTextOn: { color: colors.onInk },
    filterCount: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, color: colors.muted },
    filterCountOn: { color: colors.onInk },
    banner: { gap: space.sm, padding: space.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.status.redLine, backgroundColor: colors.status.redBg },
    bannerText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.status.redText },
    bannerAction: { flexDirection: "row" },
    note: { paddingTop: space.lg, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted, textAlign: "center" },
    pressed: { opacity: 0.7 },
    card: { gap: space.md, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    headText: { flex: 1, minWidth: 0, gap: 3 },
    nameRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
    name: { flexShrink: 1, fontFamily: font.family.semi, fontSize: 15, lineHeight: 20, color: colors.ink },
    newTag: { flexDirection: "row", alignItems: "center", gap: 4 },
    newDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.status.redDot },
    newText: { fontFamily: font.family.semi, fontSize: 12, color: colors.status.redText },
    sub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
    last: { marginTop: 3, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    lastWho: { fontFamily: font.family.medium, color: colors.ink },
    stamp: { color: colors.muted },
    photo: { width: 40, height: 40, borderRadius: 20, overflow: "hidden", backgroundColor: colors.soft },
    jobs: { gap: 2, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.line },
    jobRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
    jobText: { flex: 1, minWidth: 0, gap: 2 },
    jobTitle: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 19, color: colors.ink },
    jobLine: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    more: { alignSelf: "flex-start", paddingTop: 6 },
    moreText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    sheetJobs: { gap: 2 },
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  });
