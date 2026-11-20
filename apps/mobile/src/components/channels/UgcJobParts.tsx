import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Image, type ImageProps } from "expo-image";
import Svg, { Path } from "react-native-svg";
import { Icon, type IconName } from "../Icon";
import { UnderlinedText } from "../UnderlinedText";
import { FocusRing, hintText } from "../ZaviTextField";
import { showDialog } from "../DialogHost";
import type { Revealable } from "../useKeyboardReveal";
import { CreatorAvatar, ErrorText, ReadOnlyNote, ToneChip, UgcButton } from "./UgcParts";
import { openCheckout } from "../../features/channels/ugcCheckout";
import { useSendMessage } from "../../features/channels/ugcHooks";
import type { JobAction, JobDetail, JobReceipt, Submission } from "../../features/channels/ugc";
import {
  NOTE_MAX,
  NO_CHANGE_NOTE,
  NO_CHECKOUT_URL,
  STAGES,
  approveDialog,
  canCompose,
  changeTitle,
  chargebackNote,
  deliveryTitle,
  fileLinkLabel,
  groupActions,
  headerSub,
  headerTitle,
  historyEmptyLine,
  historyHeading,
  historySub,
  jobActions,
  jobHistory,
  noteLabel,
  pressKind,
  receiptRows,
  receiptStamp,
  stageOf,
  stamp,
  withdrawDialog,
  type FactIcon,
  type JobView,
  type Tone,
} from "../../features/channels/ugcJob";
import { useJobAction, useResumeCheckout } from "../../features/channels/ugcJobHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const PAID_ELSEWHERE = new Set(["checkout_already_paid", "creator_order_not_awaiting_checkout"]);
const paidElsewhere = (e: unknown) => PAID_ELSEWHERE.has(String((e as { code?: unknown } | null)?.code ?? ""));
const errorOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function JobHeader({ detail, view, photoUrl }: { detail: JobDetail; view: JobView; photoUrl: string | null }) {
  const styles = useStyles(makeStyles);
  const j = detail.job;
  const name = j.creator_display_name || "Creator";
  return (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        {photoUrl ? (
          <Image source={{ uri: photoUrl }} style={styles.photo} contentFit="cover" accessibilityLabel={`${name}'s photo`} />
        ) : (
          <CreatorAvatar name={name} size={48} />
        )}
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>{headerTitle(j)}</Text>
          <Text style={styles.headerSub}>{headerSub(j)}</Text>
        </View>
      </View>
      <ToneChip tone={view.chip[0]} label={view.chip[1]} />
    </View>
  );
}

export function Stepper({ status, closedReason }: { status: string; closedReason: string | null }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const at = stageOf(status, closedReason);
  if (at === null) return null;
  return (
    <View style={styles.stepper}>
      {STAGES.map((label, i) => {
        const done = i < at;
        const current = i === at;
        return (
          <View key={label} style={[styles.stepWrap, i < STAGES.length - 1 && styles.stepGrow]}>
            <View style={styles.step} accessible accessibilityLabel={`Job progress: ${label}, ${done ? "done" : current ? "in progress" : "not yet"}`}>
              <View style={[styles.dot, done ? styles.dotDone : current ? styles.dotCurrent : styles.dotFuture]}>
                {done ? (
                  <Icon name="check" size={14} color={colors.onInk} strokeWidth={2.5} />
                ) : (
                  <Text style={[styles.dotText, !current && styles.dotTextFuture]}>{i + 1}</Text>
                )}
              </View>
              <Text style={[styles.stepLabel, !(done || current) && styles.stepLabelFuture]}>{label}</Text>
            </View>
            {i < STAGES.length - 1 ? <View style={[styles.bar, i < at ? styles.barDone : null]} /> : null}
          </View>
        );
      })}
    </View>
  );
}

const FACT_ICON: Record<FactIcon, IconName> = { lock: "lock", due: "calendarList", release: "refresh", mail: "mail" };

export function StatusLines({ view }: { view: JobView }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <>
      <Text style={styles.statusTitle}>{view.title}</Text>
      {view.facts ? (
        <View style={styles.facts}>
          {view.facts.map((f) => (
            <View key={f.text} style={styles.fact}>
              <View style={styles.factIcon}>
                <Icon name={FACT_ICON[f.icon]} size={16} color={colors.ink} />
              </View>
              <View style={styles.factText}>
                <Text style={styles.factMain}>{f.text}</Text>
                {f.sub ? <Text style={styles.factSub}>{f.sub}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ) : (
        view.body.map((b) => (
          <Text key={b} style={styles.body}>
            {b}
          </Text>
        ))
      )}
    </>
  );
}

export function PayControl({
  detail,
  view,
  polling,
  restart,
  onFailed,
}: {
  detail: JobDetail;
  view: JobView;
  polling: boolean;
  restart: () => void;
  onFailed: () => void;
}) {
  const styles = useStyles(makeStyles);
  const checkout = useResumeCheckout();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const b = view.button;
  if (!b) return null;
  const busy = checkout.isPending || opening;

  function press() {
    if (!b || busy || polling || lock.current) return;
    setError(null);
    if (b.kind === "check") {
      restart();
      return;
    }
    lock.current = true;
    checkout.mutate(detail.job, {
      onSuccess: async (r) => {
        if (!r?.checkout_url) {
          lock.current = false;
          setError(NO_CHECKOUT_URL);
          return;
        }
        setOpening(true);
        try {
          await openCheckout(r.checkout_url);
        } finally {
          setOpening(false);
          lock.current = false;
          restart();
        }
      },
      onError: (e) => {
        lock.current = false;
        setError(errorOf(e, NO_CHECKOUT_URL));
        onFailed();
        if (paidElsewhere(e)) restart();
      },
    });
  }

  return (
    <View style={styles.payBox}>
      <UgcButton
        label={b.label}
        busyLabel={b.busyLabel}
        busy={busy}
        disabled={polling}
        variant={b.kind === "check" ? "secondary" : "primary"}
        onPress={press}
      />
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

export function JobActions({ detail, canWrite, reveal }: { detail: JobDetail; canWrite: boolean; reveal: (t: Revealable | null) => void }) {
  const styles = useStyles(makeStyles);
  const { colors, keyboardAppearance, textSelectionColor } = useTheme();
  const act = useJobAction(detail.job.id);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteBox = useRef<TextInput>(null);
  const lock = useRef(false);

  const actions = jobActions(detail);
  if (actions.length === 0) return null;
  if (!canWrite) return <ReadOnlyNote />;
  const busy = act.isPending || asking;
  const opened = actions.find((a) => a.action === openKey) ?? null;
  const { primary, secondary, loose, others } = groupActions(actions);

  function run(action: string, text?: string) {
    if (act.isPending || lock.current) return;
    lock.current = true;
    setError(null);
    act.mutate(
      { action, note: text },
      {
        onSuccess: () => {
          setOpenKey(null);
          setNote("");
        },
        onError: (e) => setError(errorOf(e, "Couldn't do that. Try again.")),
        onSettled: () => {
          lock.current = false;
        },
      },
    );
  }

  async function press(a: JobAction) {
    if (busy || lock.current) return;
    setError(null);
    const kind = pressKind(a);
    if (kind === "note") {
      setOpenKey(a.action);
      return;
    }
    setOpenKey(null);
    if (kind === "run") {
      run(a.action);
      return;
    }
    lock.current = true;
    setAsking(true);
    const ok = await showDialog(kind === "approve" ? approveDialog(detail) : withdrawDialog(a));
    setAsking(false);
    lock.current = false;
    if (ok) run(a.action);
  }

  const button = (a: JobAction, variant: "primary" | "secondary") => (
    <UgcButton key={a.action} label={a.label} variant={variant} disabled={busy} onPress={() => void press(a)} />
  );

  return (
    <View style={styles.actions}>
      <View style={styles.buttonRow}>
        {primary.map((a) => button(a, "primary"))}
        {secondary.map((a) => button(a, "secondary"))}
        {loose.map((a) => button(a, "secondary"))}
      </View>
      {others.length > 0 ? (
        <Pressable
          style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
          onPress={() => setMoreOpen((o) => !o)}
          accessibilityRole="button"
          accessibilityLabel="More options"
          accessibilityState={{ expanded: moreOpen }}
        >
          <Text style={styles.disclosureText}>More options</Text>
          <View style={moreOpen ? styles.chevronUp : null}>
            <Icon name="chevronDown" size={16} color={colors.muted} />
          </View>
        </Pressable>
      ) : null}
      {moreOpen && others.length > 0 ? (
        <View style={styles.moreList}>
          {others.map((a, i) => (
            <Pressable
              key={a.action}
              style={({ pressed }) => [styles.moreRow, i > 0 && styles.moreDivider, pressed && styles.pressed, busy && styles.disabled]}
              disabled={busy}
              onPress={() => void press(a)}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              accessibilityHint={a.consequence}
              accessibilityState={{ disabled: busy }}
            >
              <Text style={styles.moreLabel}>{a.label}</Text>
              <Text style={styles.moreSub}>{a.consequence}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {opened ? (
        <View style={styles.noteBox}>
          <Text style={styles.noteLabel}>{noteLabel(opened)}</Text>
          <Text style={styles.noteSub}>{opened.consequence}</Text>
          <FocusRing radius={radius.sm}>
            {(focus) => (
              <TextInput
                ref={noteBox}
                style={styles.textArea}
                value={note}
                onChangeText={setNote}
                onFocus={() => {
                  focus.onFocus();
                  reveal(noteBox.current);
                }}
                onBlur={focus.onBlur}
                multiline
                maxLength={NOTE_MAX}
                placeholderTextColor={colors.muted}
                keyboardAppearance={keyboardAppearance}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                accessibilityLabel={noteLabel(opened)}
              />
            )}
          </FocusRing>
          <View style={styles.noteButtons}>
            <UgcButton label="Not now" variant="secondary" disabled={act.isPending} onPress={() => setOpenKey(null)} />
            <UgcButton label="Send" busy={act.isPending} busyLabel="Sending" disabled={!note.trim()} onPress={() => run(opened.action, note)} />
          </View>
        </View>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <Pressable
        style={({ pressed }) => [styles.disclosure, styles.explain, pressed && styles.pressed]}
        onPress={() => setExplainOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel="What each option does"
        accessibilityState={{ expanded: explainOpen }}
      >
        <Text style={styles.disclosureText}>What each option does</Text>
        <View style={explainOpen ? styles.chevronUp : null}>
          <Icon name="chevronDown" size={16} color={colors.muted} />
        </View>
      </Pressable>
      {explainOpen ? (
        <View style={styles.explainList}>
          {actions.map((a) => (
            <Text key={a.action} style={styles.explainText}>
              <Text style={styles.explainLabel}>{a.label}: </Text>
              {a.consequence}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function JobVideoTile({
  caption,
  frame,
  busy,
  error,
  hint,
  onDownload,
  onPress,
}: {
  caption: string;
  frame?: ImageProps["source"];
  busy: boolean;
  error: string | null;
  hint?: string | null;
  onDownload?: () => void;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.tileCard}>
      <Pressable
        style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Play ${caption}`}
        accessibilityState={{ busy }}
      >
        {frame ? <Image source={frame} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        <View style={styles.playDisc}>
          {busy ? (
            <ActivityIndicator color={colors.onInk} />
          ) : (
            <Svg width={22} height={22} viewBox="0 0 24 24">
              <Path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z" fill={colors.onInk} />
            </Svg>
          )}
        </View>
        <View style={styles.tileCaption}>
          <Text style={styles.tileCaptionText} numberOfLines={1}>
            {caption}
          </Text>
        </View>
      </Pressable>
      <ErrorText>{error}</ErrorText>
      <Text style={styles.tileHint}>{hint ?? "Download it and post it from your own account or ad account."}</Text>
      {onDownload ? (
        <Pressable style={styles.link} onPress={onDownload} accessibilityRole="link" accessibilityLabel="Download the original">
          <UnderlinedText style={styles.linkText}>Download the original</UnderlinedText>
        </Pressable>
      ) : null}
    </View>
  );
}

export function JobReceiptCard({ receipt, orderId, onOpen }: { receipt: JobReceipt; orderId: string; onOpen: (url: string) => void }) {
  const styles = useStyles(makeStyles);
  const chargeback = chargebackNote(receipt);
  return (
    <View style={styles.card}>
      <View style={styles.receiptHead}>
        <Text style={styles.cardTitle}>Receipt</Text>
        <Text style={styles.meta}>{receiptStamp(receipt, orderId)}</Text>
      </View>
      {receiptRows(receipt).map((r) => (
        <View key={r.label} style={styles.kv}>
          <Text style={r.strong ? styles.kvLabelStrong : styles.kvLabel}>{r.label}</Text>
          <Text style={r.strong ? styles.kvValueStrong : styles.kvValue}>{r.value}</Text>
        </View>
      ))}
      {chargeback ? (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>{chargeback}</Text>
        </View>
      ) : null}
      {receipt.receipt_url ? (
        <Pressable style={styles.link} onPress={() => onOpen(receipt.receipt_url ?? "")} accessibilityRole="link" accessibilityLabel="Stripe receipt">
          <UnderlinedText style={styles.linkText}>Stripe receipt</UnderlinedText>
        </Pressable>
      ) : null}
    </View>
  );
}

export function OrderedCard({ lines }: { lines: string[] }) {
  const styles = useStyles(makeStyles);
  if (lines.length === 0) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>What you ordered</Text>
      {lines.map((l, i) => (
        <Text key={i} style={styles.body}>
          {l}
        </Text>
      ))}
    </View>
  );
}

export function JobHistory({
  detail,
  first,
  canWrite,
  reveal,
  onSent,
  onOpenFile,
}: {
  detail: JobDetail;
  first: string;
  canWrite: boolean;
  reveal: (t: Revealable | null) => void;
  onSent: () => void;
  onOpenFile: (file: Submission) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors, keyboardAppearance, textSelectionColor } = useTheme();
  const send = useSendMessage();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInput>(null);
  const sending = useRef(false);
  const entries = jobHistory(detail, detail.thread?.messages ?? []);
  const line = historyEmptyLine(detail, entries.length, first);
  const max = detail.revisions?.max ?? 2;
  const name = detail.job.creator_display_name || "Creator";
  const now = new Date();
  const compose = canCompose(detail);

  function submit() {
    const body = text.trim();
    if (!body || send.isPending || sending.current) return;
    sending.current = true;
    setError(null);
    send.mutate(
      { memberId: detail.job.human_member_id ?? "", threadId: detail.thread?.thread_id ?? null, body },
      {
        onSuccess: () => {
          setText("");
          onSent();
        },
        onError: (e) => setError(errorOf(e, "Couldn't send. Try again.")),
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle16}>{historyHeading(first)}</Text>
      <Text style={styles.sub}>{historySub(first)}</Text>
      {line ? <Text style={styles.body}>{line}</Text> : null}
      {entries.length > 0 ? (
        <View style={styles.history}>
          {entries.map((h) => {
            if (h.kind === "msg") {
              const mine = h.from === "me";
              return (
                <View key={h.key} style={[styles.msgWrap, mine && styles.mineWrap]}>
                  {!mine ? (
                    <Text style={styles.msgMeta}>
                      {h.from === "zavi" ? "Zavi" : name} · {stamp(h.at, now)}
                    </Text>
                  ) : null}
                  <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                    <Text style={styles.msgText} selectable>
                      {h.text}
                    </Text>
                  </View>
                  {mine ? <Text style={styles.msgMeta}>{stamp(h.at, now)}</Text> : null}
                </View>
              );
            }
            if (h.kind === "change") {
              return (
                <View key={h.key} style={styles.changeCard}>
                  <Text style={styles.entryTitle}>
                    {changeTitle(h.round, max)}
                    <Text style={styles.entryStamp}> · {stamp(h.at, now)}</Text>
                  </Text>
                  <Text style={styles.body}>{h.note ?? NO_CHANGE_NOTE}</Text>
                </View>
              );
            }
            return (
              <View key={h.key} style={styles.deliveryCard}>
                <Text style={styles.entryTitle}>
                  {deliveryTitle(first, h.version)}
                  <Text style={styles.entryStamp}> · {stamp(h.at, now)}</Text>
                </Text>
                {h.note ? <Text style={styles.quote}>“{h.note}”</Text> : null}
                <View style={styles.fileRow}>
                  {h.files.map((f, i) =>
                    f.play_url ? (
                      <Pressable key={f.id} style={styles.link} onPress={() => onOpenFile(f)} accessibilityRole="button" accessibilityLabel={fileLinkLabel(f, i, h.files.length)}>
                        <UnderlinedText style={styles.linkText}>{fileLinkLabel(f, i, h.files.length)}</UnderlinedText>
                      </Pressable>
                    ) : (
                      <Text key={f.id} style={styles.meta}>
                        {fileLinkLabel(f, i, h.files.length)}
                      </Text>
                    ),
                  )}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {compose && !canWrite ? <ReadOnlyNote /> : null}
      {compose && canWrite ? (
        <>
          <View style={styles.composer}>
            <TextInput
              ref={input}
              style={styles.composerInput}
              value={text}
              onChangeText={setText}
              onFocus={() => reveal(input.current)}
              placeholder={hintText(`Message ${first}`)}
              placeholderTextColor={colors.muted}
              keyboardAppearance={keyboardAppearance}
              selectionColor={textSelectionColor}
              cursorColor={colors.ink}
              selectionHandleColor={colors.ink}
              multiline
              maxLength={NOTE_MAX}
              accessibilityLabel={`Message ${first}`}
            />
            <Pressable
              style={[styles.send, (!text.trim() || send.isPending) && styles.disabled]}
              onPress={submit}
              disabled={!text.trim() || send.isPending}
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !text.trim() || send.isPending, busy: send.isPending }}
            >
              {send.isPending ? <ActivityIndicator color={colors.onInk} /> : <Icon name="send" size={18} color={colors.onInk} />}
            </Pressable>
          </View>
          <ErrorText>{error}</ErrorText>
        </>
      ) : null}
    </View>
  );
}

export function NextAdLine({ rights, onOpen }: { rights: string; onOpen: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.nextBox}>
      <View style={styles.nextRow}>
        <Text style={styles.nextText}>Next: </Text>
        <Pressable style={styles.link} onPress={onOpen} accessibilityRole="link" accessibilityLabel="Run it as an ad in Meta Ads">
          <UnderlinedText style={styles.nextLink}>run it as an ad in Meta Ads</UnderlinedText>
        </Pressable>
        <Text style={styles.nextText}>.</Text>
      </View>
      {rights ? <Text style={styles.nextText}>{rights.trim()}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    cardTitle: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
    cardTitle16: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    body: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
    meta: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 16, color: colors.muted },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.4 },

    header: { gap: space.sm },
    headerTop: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    photo: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.soft },
    headerText: { flex: 1, minWidth: 0, gap: 2 },
    headerTitle: { fontFamily: font.family.semi, fontSize: 20, lineHeight: 26, color: colors.ink },
    headerSub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },

    stepper: { flexDirection: "row", alignItems: "flex-start", marginBottom: space.sm },
    stepWrap: { flexDirection: "row", alignItems: "flex-start" },
    stepGrow: { flex: 1 },
    step: { alignItems: "center", gap: 4 },
    dot: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
    dotDone: { backgroundColor: colors.ink },
    dotCurrent: { borderWidth: 2, borderColor: colors.ink, backgroundColor: colors.bg },
    dotFuture: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
    dotText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, color: colors.ink },
    dotTextFuture: { color: colors.muted },
    stepLabel: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, color: colors.ink },
    stepLabelFuture: { color: colors.muted },
    bar: { flex: 1, height: 2, marginTop: 11, marginHorizontal: 4, borderRadius: 1, backgroundColor: colors.line },
    barDone: { backgroundColor: colors.ink },

    statusTitle: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    facts: { gap: space.md, marginTop: 4 },
    fact: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    factIcon: { width: 32, height: 32, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.soft },
    factText: { flex: 1, minWidth: 0, gap: 2, paddingTop: 2 },
    factMain: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    factSub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },

    payBox: { gap: space.sm, marginTop: space.sm },

    actions: { gap: space.sm, marginTop: space.sm },
    buttonRow: { gap: space.sm },
    disclosure: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 4, minHeight: 36 },
    disclosureText: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 18, color: colors.textSecondary },
    chevronUp: { transform: [{ rotate: "180deg" }] },
    moreList: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
    moreRow: { gap: 2, paddingHorizontal: space.md, paddingVertical: 10 },
    moreDivider: { borderTopWidth: 1, borderTopColor: colors.line },
    moreLabel: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
    moreSub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    noteBox: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    noteLabel: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    noteSub: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    textArea: {
      minHeight: 84,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      fontFamily: font.family.medium,
      fontSize: 15,
      lineHeight: 20,
      color: colors.ink,
      textAlignVertical: "top",
    },
    noteButtons: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm },
    explain: { marginTop: 4, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.line, alignSelf: "stretch" },
    explainList: { gap: space.sm },
    explainText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    explainLabel: { fontFamily: font.family.semi, color: colors.ink },

    tileCard: { alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    tile: { width: 180, aspectRatio: 9 / 16, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", overflow: "hidden", backgroundColor: colors.line },
    playDisc: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
    tileCaption: { position: "absolute", left: space.sm, right: space.sm, bottom: space.sm, alignItems: "flex-start" },
    tileCaptionText: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: "hidden", backgroundColor: colors.bg, fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, color: colors.ink },
    tileHint: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary, textAlign: "center" },

    receiptHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md, flexWrap: "wrap" },
    kv: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md },
    kvLabel: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    kvValue: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    kvLabelStrong: { flex: 1, fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    kvValueStrong: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    warnBox: { padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.status.amberBg },
    warnText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.status.amberText },
    link: { alignSelf: "flex-start", paddingVertical: 4 },
    linkText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },

    history: { gap: space.sm, marginTop: 4 },
    msgWrap: { alignItems: "flex-start", gap: 2 },
    mineWrap: { alignItems: "flex-end" },
    msgMeta: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 16, color: colors.muted },
    bubble: { maxWidth: "85%", paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.lg },
    mine: { backgroundColor: colors.bubbleUserBg },
    theirs: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line },
    msgText: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.ink },
    changeCard: { gap: 4, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    deliveryCard: { gap: 4, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
    entryTitle: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    entryStamp: { fontFamily: font.family.regular, color: colors.muted },
    quote: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
    fileRow: { flexDirection: "row", flexWrap: "wrap", columnGap: space.md },
    composer: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, marginTop: 4 },
    composerInput: {
      flex: 1,
      minHeight: 40,
      maxHeight: 140,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.lg,
      fontFamily: font.family.medium,
      fontSize: 15,
      lineHeight: 20,
      color: colors.ink,
    },
    send: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: colors.ink },

    nextBox: { gap: 4, paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    nextRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline" },
    nextText: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.ink },
    nextLink: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
  });
