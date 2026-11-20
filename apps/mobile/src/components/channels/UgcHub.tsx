import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { ExtraCard } from "./ChannelNextSteps";
import { CardFooter, Chip, openOnWeb } from "./UgcParts";
import { UnderlinedText } from "../UnderlinedText";
import { VideoCardView, useReadyVideoCards } from "./UgcVideoCards";
import {
  hireCards,
  hubNumbers,
  isNeverPaid,
  jobNeedsYou,
  laneRows,
  money,
  NO_FILTERS,
  UGC_SLUG,
  type HireCard,
} from "../../features/channels/ugc";
import { useBriefs, useCreatorSearch, useDeliveredVideos, useJobs, useNotices, useUnreadCount } from "../../features/channels/ugcHooks";
import { metricTiles } from "../../features/channels/channelPage";
import { NumbersCard } from "./ChannelPageSections";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";

const LANE_TOP = 5;

const RANK: Record<string, number> = { Brief: 1, Applicants: 2, Book: 3, Review: 4, "To do": 5, "More time": 5, Waiting: 6 };
const rank = (kind: string) => RANK[kind] ?? 7;

function useUgcRows(enabled = true) {
  const jobs = useJobs(enabled);
  const briefs = useBriefs(enabled);
  const search = useCreatorSearch(NO_FILTERS, enabled);
  const jobList = jobs.data ?? [];
  const briefList = briefs.data ?? [];
  const bookable = (search.data?.creators ?? []).filter((c) => c.bookable).length;
  return { jobs, briefs, jobList, briefList, bookable };
}

type CardProps = {
  kind: string;
  title: string;
  lead: string;
  tone?: "alert" | "soft";
  price?: string;
  primary: { label: string; onPress: () => void };
  dismiss?: { label: string; onPress: () => void };
};

function UgcCard({ kind, title, lead, tone = "soft", price, primary, dismiss }: CardProps) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.cardText}>
          <Chip tone={tone} label={kind} />
          <Text style={styles.title}>{title}</Text>
          {lead ? <Text style={styles.sub}>{lead}</Text> : null}
        </View>
        {price ? <Text style={styles.price}>{price}</Text> : null}
      </View>
      <CardFooter primary={primary} dismiss={dismiss} askAbout={title} />
    </View>
  );
}

const HIDDEN_KEY = "zavi.creatorCards.hidden";

function useHiddenCards(): { hidden: string[]; hide: (id: string) => void } {
  const tenant = useActiveTenant();
  const key = `${HIDDEN_KEY}.${tenant}`;
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void AsyncStorage.getItem(key)
      .then((raw) => {
        const v: unknown = raw ? JSON.parse(raw) : [];
        if (live && Array.isArray(v)) setHidden(v.filter((x): x is string => typeof x === "string"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  const hide = useCallback(
    (id: string) =>
      setHidden((h) => {
        const next = [...h.filter((x) => x !== id), id].slice(-200);
        void AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {});
        return next;
      }),
    [key],
  );
  return { hidden, hide };
}

export function useExtraCards(slug: string): ExtraCard[] {
  const router = useRouter();
  const { jobList, briefList, bookable } = useUgcRows(slug === UGC_SLUG);
  const { hidden, hide } = useHiddenCards();
  const videos = useReadyVideoCards(slug);
  const videoCards: ExtraCard[] = videos.map((v) => ({
    id: v.id,
    kind: v.kind,
    node: <VideoCardView card={v} dismiss={{ label: slug === UGC_SLUG ? "Not now" : "Reject", onPress: () => hide(v.id) }} />,
  }));
  if (slug !== UGC_SLUG) return videoCards.filter((c) => !hidden.includes(c.id));

  const open = (path: string, id?: string) =>
    id ? router.push({ pathname: path as never, params: { id } }) : router.push(path as never);
  const press = (c: HireCard) => {
    if (c.to === "find") open("/channels/ugc/find");
    else if (c.to === "job" && c.jobId) open("/channels/ugc/job/[id]", c.jobId);
    else if (c.to === "brief" && c.briefId) open("/channels/ugc/brief/[id]", c.briefId);
    else if (c.to === "applicants" && c.briefId) open("/channels/ugc/applicants/[id]", c.briefId);
    else openOnWeb();
  };

  const hire: ExtraCard[] = hireCards(briefList, jobList, bookable).map((c) => ({
    id: c.id,
    kind: c.kind,
    node: (
      <UgcCard
        kind={c.kind}
        title={c.title}
        lead={c.lead}
        primary={{ label: c.button, onPress: () => press(c) }}
        dismiss={c.dismiss ? { label: c.dismiss, onPress: () => hide(c.id) } : undefined}
      />
    ),
  }));
  const jobCards: ExtraCard[] = jobList
    .filter((j) => !isNeverPaid(j) && jobNeedsYou(j))
    .map((j) => {
      const review = j.status === "submitted";
      const kind = review ? "Review" : "More time";
      const who = j.creator_display_name || "Your creator";
      return {
        id: `job-${j.id}`,
        kind,
        node: (
          <UgcCard
            kind={kind}
            tone="alert"
            title={review ? `${who} delivered: review it` : `${who} asked for more time: ${j.title}`}
            lead={review ? "Watch it, then approve or ask for changes." : "Open the job to answer."}
            price={money(j.money.business_total_cents)}
            primary={{ label: review ? "Review delivery" : "Open job", onPress: () => open("/channels/ugc/job/[id]", j.id) }}
          />
        ),
      };
    });
  return [...hire, ...jobCards, ...videoCards]
    .filter((c) => !hidden.includes(c.id))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c.kind) - rank(b.c.kind) || a.i - b.i)
    .map((x) => x.c);
}

export function UgcHeaderButtons() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const unread = useUnreadCount();
  const notices = useNotices();
  const buttons = [
    { label: "Find creators", path: "/channels/ugc/find", badge: 0 },
    { label: "Creators", path: "/channels/ugc/inbox", badge: unread },
    { label: "Updates", path: "/channels/ugc/notices", badge: notices.data?.unread ?? 0 },
  ] as const;
  return (
    <View style={styles.buttons}>
      {buttons.map((b) => (
        <Pressable
          key={b.path}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          onPress={() => router.push(b.path)}
          accessibilityRole="button"
          accessibilityLabel={b.badge ? `${b.label}, ${b.badge} new` : b.label}
        >
          <Text style={styles.buttonText}>{b.label}</Text>
          {b.badge > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{b.badge > 9 ? "9+" : b.badge}</Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

export function UgcNumbers() {
  const { jobs, briefs, jobList, briefList } = useUgcRows();
  const delivered = useDeliveredVideos(true);
  const ready = !!jobs.data && !!briefs.data && delivered.ready;
  const metrics = ready ? hubNumbers(briefList, jobList, delivered.videos) : [];
  return <NumbersCard slug={UGC_SLUG} tiles={metricTiles(UGC_SLUG, metrics)} connected needsConnect={false} connectors={[]} loading={!ready} />;
}

export function UgcLane() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { briefList, jobList } = useUgcRows();
  const [showAll, setShowAll] = useState(false);
  const lane = laneRows(briefList, jobList);
  if (lane.length === 0) return null;
  const shown = showAll ? lane : lane.slice(0, LANE_TOP);

  return (
    <View style={styles.lane}>
      <Text style={styles.sectionTitle}>Your creators</Text>
      <Text style={styles.sub}>Briefs you posted and the jobs running from them. Open one to see applicants, messages and the work.</Text>
      {shown.map((r) => (
        <Pressable
          key={r.id}
          style={({ pressed }) => [styles.laneRow, pressed && styles.pressed]}
          onPress={() =>
            r.jobId
              ? router.push({ pathname: "/channels/ugc/job/[id]", params: { id: r.jobId } })
              : r.briefId
                ? router.push({ pathname: "/channels/ugc/applicants/[id]", params: { id: r.briefId } })
                : openOnWeb()
          }
          accessibilityRole="button"
          accessibilityLabel={`${r.kind}: ${r.title}, ${r.status}`}
        >
          <View style={styles.cardText}>
            <Text style={styles.title} numberOfLines={2}>
              {r.title}
            </Text>
            {r.line ? <Text style={styles.sub}>{r.line}</Text> : null}
          </View>
          <Chip label={r.status} tone={r.tone === "action" ? "alert" : "soft"} />
        </Pressable>
      ))}
      {lane.length > LANE_TOP ? (
        <Pressable style={styles.linkWrap} onPress={() => setShowAll((v) => !v)} hitSlop={8} accessibilityRole="button">
          <UnderlinedText style={styles.link}>{showAll ? "Show fewer" : `Show all ${lane.length}`}</UnderlinedText>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md },
    button: {
      minHeight: 40,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
      backgroundColor: colors.panel,
    },
    buttonText: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    badge: { minWidth: 18, height: 18, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: colors.ink },
    badgeText: { fontFamily: font.family.semi, fontSize: 11, color: colors.onInk },
    pressed: { opacity: 0.7 },
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    cardTop: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    cardText: { flex: 1, alignItems: "flex-start", gap: 4 },
    title: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    numbersWrap: { gap: space.sm, marginTop: space.lg },
    sectionTitle: { fontFamily: font.family.semi, fontSize: 17, letterSpacing: -0.2, color: colors.ink },
    numbers: { flexDirection: "row", gap: 6 },
    number: { flex: 1, gap: 0, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    numberValue: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 21, color: colors.ink },
    linkWrap: { alignSelf: "flex-start" },
    link: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    lane: { gap: space.sm, marginTop: space.lg + space.xs },
    laneRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
    price: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
  });
