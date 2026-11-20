import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { GrowthPlan, NoteSectionKey } from "../../features/growth/plan";
import {
  WRONG_CALL_LINE,
  claimError,
  claimForLine,
  claimOutcome,
  nextLine,
  rowKey,
  shownSections,
  undoLive,
  wouldChangeFooter,
  type Claim,
} from "../../features/growth/note";
import { useFlagMistake } from "../../features/growth/hooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { AppBottomSheet } from "../AppBottomSheet";
import { Icon, type IconName } from "../Icon";
import { ErrorLine, TextLink } from "./StoryKit";

type ClaimState = "busy" | { said: string };

export function NoteSheet({
  open,
  onClose,
  plan,
  canClaim,
  nameOf,
  onOpenLink,
}: {
  open: boolean;
  onClose: () => void;
  plan: GrowthPlan;
  canClaim: boolean;
  nameOf: (slug: string) => string;
  onOpenLink: (url: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const flag = useFlagMistake();
  const [claimed, setClaimed] = useState<Record<string, ClaimState>>({});
  const [error, setError] = useState<string | null>(null);
  const claim = async (key: string, body: Claim) => {
    setClaimed((m) => ({ ...m, [key]: "busy" }));
    setError(null);
    try {
      const reply = await flag.mutateAsync(body);
      setClaimed((m) => ({ ...m, [key]: { said: claimOutcome(reply) } }));
    } catch (e) {
      setClaimed((m) => {
        const rest = { ...m };
        delete rest[key];
        return rest;
      });
      setError(claimError(e as { code?: string; message?: string }));
    }
  };
  const hog = plan.head_of_growth;
  const note = hog.note;
  const unavailable = plan.unreadable.includes("head_of_growth");
  const next = unavailable ? null : nextLine(hog);
  const sections = shownSections(note);

  return (
    <AppBottomSheet open={open} onClose={onClose} title="Latest note from Zavi">
      <View style={styles.head}>
        <Text style={styles.headText}>Your head of growth · latest note</Text>
        {next ? <Text style={styles.headText}>{next}</Text> : null}
      </View>
      {unavailable ? (
        <Text style={styles.muted}>Couldn't load my latest note.</Text>
      ) : note === null ? (
        <Text style={styles.muted}>My first note comes after I review your goals and channels.</Text>
      ) : note.sections ? (
        <>
          {note.headline ? <Text style={styles.headline}>{note.headline}</Text> : null}
          {sections.map((sec) => (
            <Section key={sec.key} title={sec.title} tone={sec.key}>
              {sec.rows.map((r, i) => {
                const body = r.undo ? undoLive(r.undo, hog, plan.channels) : null;
                const key = rowKey(r.undo, sec.key, i);
                return (
                  <Line
                    key={i}
                    dot={sec.key}
                    text={r.line}
                    link={r.url ? () => onOpenLink(r.url as string) : undefined}
                    claim={canClaim && body ? () => void claim(key, body) : undefined}
                    state={claimed[key]}
                  />
                );
              })}
              {sec.more ? (
                <View style={styles.moreRow}>
                  <Text style={styles.small}>{sec.more.line}</Text>
                  <TextLink label="Open" onPress={() => onOpenLink(sec.more!.url)} />
                </View>
              ) : null}
              {sec.key === "would_change" ? <Text style={styles.small}>{wouldChangeFooter(hog.autopilot)}</Text> : null}
            </Section>
          ))}
          {note.saw.length > 0 ? (
            <Section title="What I saw" tone="saw">
              {note.saw.map((l, i) => (
                <Line key={i} dot="saw" text={l} />
              ))}
            </Section>
          ) : null}
          {sections.some((sec) => sec.rows.some((r) => r.undo)) ? <Text style={styles.wrong}>{WRONG_CALL_LINE}</Text> : null}
        </>
      ) : (
        <>
          {note.saw.length > 0 ? (
            <Section title="What I saw" tone="saw">
              {note.saw.map((l, i) => (
                <Line key={i} dot="saw" text={l} />
              ))}
            </Section>
          ) : null}
          {note.changed.length > 0 ? (
            <Section title="What I changed" tone="changed">
              {note.changed.map((l, i) => {
                const body = claimForLine(l, hog, plan.channels, nameOf);
                const key = `line:${i}`;
                return (
                  <Line
                    key={i}
                    dot="changed"
                    text={l}
                    claim={canClaim && body ? () => void claim(key, body) : undefined}
                    state={claimed[key]}
                  />
                );
              })}
            </Section>
          ) : null}
          {note.would_change.length > 0 ? (
            <Section title="What I'd change" tone="would_change">
              {note.would_change.map((l, i) => (
                <Line key={i} dot="would_change" text={l} />
              ))}
              <Text style={styles.small}>{wouldChangeFooter(hog.autopilot)}</Text>
            </Section>
          ) : null}
          {note.need.length > 0 ? (
            <Section title="What I need from you" tone="needs_you">
              {note.need.map((l, i) => (
                <Line key={i} dot="needs_you" text={l} />
              ))}
            </Section>
          ) : null}
        </>
      )}
      {error ? (
        <View style={styles.errorWrap}>
          <ErrorLine>{error}</ErrorLine>
        </View>
      ) : null}
    </AppBottomSheet>
  );
}

type Tone = NoteSectionKey | "saw";

const SECTION_ICON: Record<Tone, IconName> = {
  needs_you: "hand",
  changed: "check",
  decided: "check",
  would_change: "sparkles",
  working_on: "loader",
  blocked: "shieldAlert",
  saw: "eye",
};

function Section({ title, tone, children }: { title: string; tone: Tone; children: React.ReactNode }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const color = tone === "needs_you" ? colors.status.amberText : colors.ink;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Icon name={SECTION_ICON[tone]} size={14} color={color} strokeWidth={2} />
        <Text style={[styles.sectionTitle, { color }]} accessibilityRole="header">
          {title.toUpperCase()}
        </Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Line({
  text,
  dot,
  link,
  claim,
  state,
}: {
  text: string;
  dot: Tone;
  link?: () => void;
  claim?: () => void;
  state?: ClaimState;
}) {
  const styles = useStyles(makeStyles);
  const done = typeof state === "object";
  return (
    <View style={styles.line}>
      <View style={[styles.dot, dot === "needs_you" && styles.dotNeeds, dot === "changed" && styles.dotInk]} />
      <View style={styles.lineBody}>
        <Text style={[styles.lineText, done && styles.struck]}>{text}</Text>
        {link ? <TextLink label="Open" onPress={link} /> : null}
        {claim && !done ? (
          <Pressable
            onPress={state === "busy" ? undefined : claim}
            style={({ pressed }) => [styles.claim, pressed && styles.claimPressed, state === "busy" && styles.claimBusy]}
            accessibilityRole="button"
            accessibilityState={{ busy: state === "busy", disabled: state === "busy" }}
          >
            <Text style={styles.claimText}>{state === "busy" ? "Undoing…" : "This was a mistake"}</Text>
          </Pressable>
        ) : null}
        {done ? (
          <Text style={styles.said} accessibilityLiveRegion="polite">
            {state.said}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.sm, marginBottom: space.md },
    headText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    headline: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, includeFontPadding: false, color: colors.ink, marginBottom: space.md },
    muted: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.muted },
    section: { marginTop: space.lg },
    sectionTitle: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.ink, letterSpacing: 0.6 },
    sectionHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    sectionBody: { marginTop: space.sm, gap: space.sm },
    line: { flexDirection: "row", gap: 10 },
    dot: { width: 5, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: colors.muted },
    dotNeeds: { backgroundColor: colors.status.amberDot },
    dotInk: { backgroundColor: colors.ink },
    lineBody: { flex: 1, gap: 2 },
    lineText: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.textSecondary },
    moreRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.sm },
    struck: { textDecorationLine: "line-through", color: colors.muted },
    claim: {
      alignSelf: "flex-start",
      minHeight: 32,
      justifyContent: "center",
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.line,
      paddingHorizontal: 10,
    },
    claimPressed: { backgroundColor: colors.soft },
    claimBusy: { opacity: 0.5 },
    claimText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.textSecondary },
    said: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.ink },
    wrong: { marginTop: space.lg, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    errorWrap: { marginTop: space.lg },
    small: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
  });
