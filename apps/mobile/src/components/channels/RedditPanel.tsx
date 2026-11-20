import { useEffect, useRef, useState } from "react";
import { Clipboard, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { AppBottomSheet } from "../AppBottomSheet";
import { Icon } from "../Icon";
import { SpinningIcon } from "../SpinningIcon";
import { OptionSheet } from "../OptionSheet";
import { ZaviTextField } from "../ZaviTextField";
import { TextLink } from "../growth/StoryKit";
import { CardButton } from "../reply/ui";
import {
  BANNED_POST_LINE,
  DRAFT_MAX_CHARS,
  VERDICT_OPTIONS,
  agoShort,
  draftEditBlocked,
  relevanceLevel,
  redditTable,
  redditTiles,
  replyPasteHint,
  scanBlocked,
  scanState,
  threadBanned,
  verdictLabel,
  type Cell,
  type RedditPayload,
  type RedditTable,
  type RedditTableId,
  type TableRow,
} from "../../features/channels/reddit";
import { dismissReplyDraft, draftReply, markReplyPosted, saveReplyDraft, saveVerdict, startScan } from "../../features/channels/redditHooks";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const open = (url: string) => void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => {}));

export function RedditScanControl({
  payload,
  surfaceOff,
  onRefresh,
}: {
  payload: RedditPayload | null | undefined;
  surfaceOff: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const state = scanState(payload);
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firing = useRef(false);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 2000);
    return () => clearTimeout(t);
  }, [error]);

  if (!payload) return null;
  const running = !!state?.running || pending;
  const blocked = state ? scanBlocked(state) : null;
  const canScan = !!state && !surfaceOff && !blocked && !running;

  const press = async () => {
    if (firing.current) return;
    firing.current = true;
    setError(null);
    try {
      if (canScan) {
        setPending(true);
        const err = await startScan();
        if (err) setError(err);
        await onRefresh().catch(() => {});
      } else {
        setRefreshing(true);
        await onRefresh().catch(() => {});
      }
    } finally {
      firing.current = false;
      setPending(false);
      setRefreshing(false);
    }
  };

  return (
    <View style={styles.scanWrap}>
      <View style={styles.scanRow}>
        {}
        <View style={styles.scanPill} accessibilityLabel={running ? "Scanning" : blocked ?? (state?.lastAt ? `Scanned ${agoShort(state.lastAt)}` : "Not scanned yet")}>
          {running ? (
            <Text style={styles.scanText} numberOfLines={1}>
              Scanning…
            </Text>
          ) : (
            <>
              {state ? (
                <View
                  style={[styles.dot, { backgroundColor: state.fresh ? colors.status.greenDot : colors.wire.faint }]}
                  accessibilityLabel={state.fresh ? "Scanned in the last 24 hours" : "No successful scan in the last 24 hours"}
                />
              ) : null}
              <Text style={styles.scanText} numberOfLines={1}>
                {blocked ?? (state?.lastAt ? `Scanned ${agoShort(state.lastAt)}` : "Not scanned yet")}
              </Text>
            </>
          )}
        </View>
        <Pressable
          style={({ pressed }) => [styles.scanButton, pressed && styles.pressed, (pending || refreshing || running) && styles.dim]}
          onPress={() => void press()}
          disabled={pending || refreshing || running}
          accessibilityRole="button"
          accessibilityLabel={canScan ? "Scan now" : "Refresh"}
          accessibilityHint={canScan ? undefined : blocked ? `${blocked} This re-reads the latest numbers.` : "This re-reads the latest numbers."}
        >
          <SpinningIcon name="refresh" size={17} color={colors.ink} spinning={running || refreshing || pending} />
        </Pressable>
      </View>
      {error ? (
        <Text style={styles.scanError} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function RedditNumbers({
  payload,
  loading,
  defaultTable = "brand",
  onChanged,
}: {
  payload: RedditPayload | null | undefined;
  loading: boolean;
  defaultTable?: RedditTableId;
  onChanged: () => Promise<unknown>;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [picked, setPicked] = useState<RedditTableId>(defaultTable);
  const tiles = redditTiles(payload);
  const table = redditTable(payload, picked);
  const measured = !!table;

  return (
    <>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        How the account is doing
      </Text>
      <View style={styles.tiles}>
        {tiles.map((t) => {
          const on = measured && t.table === picked;
          return (
            <Pressable
              key={t.key}
              style={[styles.tile, on && styles.tileOn]}
              onPress={measured ? () => setPicked(t.table) : undefined}
              disabled={!measured}
              accessibilityRole={measured ? "tab" : undefined}
              accessibilityState={measured ? { selected: on } : undefined}
            >
              <View style={styles.tileHead}>
                <Icon name={t.icon} size={14} color={colors.muted} />
                <Text style={styles.tileLabel} numberOfLines={1}>
                  {t.label}
                </Text>
              </View>
              {loading ? (
                <View style={styles.slot} />
              ) : (
                <View style={styles.tileValueRow}>
                  <Text style={styles.tileValue}>{t.value}</Text>
                  {t.delta ? <Text style={[styles.delta, t.delta.up ? styles.good : styles.bad]}>{t.delta.text}</Text> : null}
                </View>
              )}
              {!loading && !measured ? <Text style={styles.small}>Not measured yet</Text> : null}
            </Pressable>
          );
        })}
      </View>
      {table ? <TableCard key={table.id} payload={payload as RedditPayload} table={table} onChanged={onChanged} /> : null}
    </>
  );
}

function TableCard({ payload, table, onChanged }: { payload: RedditPayload; table: RedditTable; onChanged: () => Promise<unknown> }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [showTail, setShowTail] = useState(false);
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [terms, setTerms] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tailFrom = table.tailFrom ?? table.rows.length;
  const tail = table.rows.length - tailFrom;
  const rows = showTail ? table.rows : table.rows.slice(0, tailFrom);
  const draftRow = table.rows.find((r) => r.key === openDraft && r.action?.kind === "draft");

  return (
    <View style={styles.card}>
      <View style={styles.tableHead}>
        <Icon name={table.icon} size={16} color={colors.ink} />
        <Text style={styles.tableTitle}>{table.title}</Text>
      </View>
      {table.rows.length === 0 ? (
        <Text style={styles.emptyBox}>{table.empty}</Text>
      ) : rows.length === 0 ? (
        <Text style={styles.emptyBox}>No subreddit scored Medium or higher yet.</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleed} contentContainerStyle={styles.bleedInner}>
          <View style={styles.grid}>
            <View style={[styles.gridRow, styles.gridHead]}>
              {table.columns.map((c, i) => (
                <View key={c.label} style={[styles.cell, { width: c.width }, i > 0 && styles.cellDivider]}>
                  <Text style={[styles.headText, c.align === "right" && styles.right]}>{c.label}</Text>
                </View>
              ))}
            </View>
            {rows.map((r) => (
              <View key={r.key} style={[styles.gridRow, styles.rowDivider]}>
                {r.cells.map((cell, i) => (
                  <View key={i} style={[styles.cell, { width: table.columns[i]?.width ?? 120 }, i > 0 && styles.cellDivider]}>
                    <CellView cell={cell} onTerms={setTerms} onChanged={onChanged} />
                    {i === 0 && r.action ? (
                      <RowActionLink
                        row={r}
                        open={openDraft === r.key}
                        onToggle={() => {
                          setNotice(null);
                          setOpenDraft((k) => (k === r.key ? null : r.key));
                        }}
                        onChanged={onChanged}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            ))}
            {table.footer ? (
              <View style={[styles.gridRow, styles.rowDivider, styles.gridHead]}>
                {table.footer.map((f, i) => (
                  <View key={i} style={[styles.cell, { width: table.columns[i]?.width ?? 120 }, i > 0 && styles.cellDivider]}>
                    <Text style={[styles.footText, table.columns[i]?.align === "right" && styles.right]}>{f}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
      {tail > 0 ? (
        <TextLink
          label={showTail ? "Hide low-relevance subreddits" : `Show ${tail} low-relevance ${tail === 1 ? "subreddit" : "subreddits"}`}
          expanded={showTail}
          onPress={() => setShowTail((v) => !v)}
        />
      ) : null}
      {draftRow && draftRow.action?.kind === "draft" && draftRow.action.draft ? (
        <DraftPanel
          key={draftRow.action.threadId}
          title={draftRow.cells[0]?.kind === "link" ? draftRow.cells[0].text : ""}
          url={draftRow.cells[0]?.kind === "link" ? draftRow.cells[0].url : ""}
          threadId={draftRow.action.threadId}
          draft={draftRow.action.draft}
          banned={threadBanned(payload, draftRow.action.threadId)}
          onChanged={onChanged}
          onDismissed={() => {
            setOpenDraft(null);
            setNotice("Draft dismissed.");
          }}
        />
      ) : null}
      {notice ? <Text style={styles.small}>{notice}</Text> : null}
      <Text style={styles.small}>{table.caption}</Text>
      <AppBottomSheet open={!!terms} onClose={() => setTerms(null)} title={terms && terms.length === 1 ? "Matched keyword" : `Matched keywords · ${terms?.length ?? 0}`}>
        <View style={styles.chips}>
          {(terms ?? []).map((t) => (
            <Text key={t} style={[styles.chip, styles.chipMuted]}>
              {t}
            </Text>
          ))}
        </View>
      </AppBottomSheet>
    </View>
  );
}

function CellView({ cell, onTerms, onChanged }: { cell: Cell; onTerms: (t: string[]) => void; onChanged: () => Promise<unknown> }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  switch (cell.kind) {
    case "text":
      return <Text style={[styles.cellText, cell.dim && styles.dimText, cell.align === "right" && styles.right]}>{cell.text}</Text>;
    case "link":
      return (
        <View style={styles.linkCell}>
          <Pressable onPress={() => open(cell.url)} accessibilityRole="link" hitSlop={4}>
            <Text style={styles.linkText} numberOfLines={3}>
              {cell.text}
            </Text>
          </Pressable>
          {cell.sub ? (
            <Text style={styles.small} numberOfLines={2}>
              {cell.sub}
            </Text>
          ) : null}
        </View>
      );
    case "chip":
      return (
        <Text style={[styles.chip, cell.tone === "good" ? styles.chipGood : cell.tone === "bad" ? styles.chipBad : styles.chipMuted]}>
          {cell.text}
        </Text>
      );
    case "meter":
      if (cell.value === null || cell.value === undefined) return <Text style={[styles.cellText, styles.dimText]}>—</Text>;
      return (
        <View style={styles.meterRow}>
          <View style={styles.meterTrack}>
            <View style={[styles.meterFill, { width: `${Math.max(0, Math.min(100, cell.value))}%` }]} />
          </View>
          <Text style={styles.cellText}>{`${Math.round(cell.value)} ${relevanceLevel(cell.value)}`}</Text>
          {cell.terms.length > 0 ? (
            <Pressable
              onPress={() => onTerms(cell.terms)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Show ${cell.terms.length} matched ${cell.terms.length === 1 ? "keyword" : "keywords"}`}
            >
              <Icon name="alertCircle" size={15} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      );
    case "verdict":
      return <VerdictCell name={cell.name} value={cell.value} onChanged={onChanged} />;
  }
}

function VerdictCell({ name, value, onChanged }: { name: string; value: string | null; onChanged: () => Promise<unknown> }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [shown, setShown] = useState(value);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setShown(value), [value]);

  const pick = async (v: string | null) => {
    if (v === shown) return;
    const before = shown;
    setShown(v);
    setSaving(true);
    setError(null);
    const err = await saveVerdict(name, v);
    setSaving(false);
    if (err) {
      setShown(before);
      setError(err);
    } else void onChanged();
  };

  const bare = name.replace(/^r\//i, "");
  return (
    <View style={styles.linkCell}>
      <Pressable
        style={[styles.select, saving && styles.dim]}
        onPress={() => setOpen(true)}
        disabled={saving}
        accessibilityRole="button"
        accessibilityLabel={`Self-promo in r/${bare} (your reading of its rules)`}
      >
        <Text style={styles.cellText}>{verdictLabel(shown)}</Text>
        <Icon name="chevronDown" size={14} color={colors.muted} strokeWidth={2} />
      </Pressable>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <OptionSheet
        open={open}
        title={`Self-promo in r/${bare}`}
        options={VERDICT_OPTIONS}
        value={shown}
        onPick={(v) => void pick(v)}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

function RowActionLink({ row, open: isOpen, onToggle, onChanged }: { row: TableRow; open: boolean; onToggle: () => void; onChanged: () => Promise<unknown> }) {
  const styles = useStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = row.action;
  if (!action) return null;
  if (action.kind === "reply") {
    return (
      <View style={styles.rowAction}>
        <TextLink label="Reply" accessibilityLabel={action.label} onPress={() => open(action.url)} />
      </View>
    );
  }
  if (action.draft) {
    return (
      <View style={styles.rowAction}>
        <TextLink label={isOpen ? "Hide draft" : "Show draft"} expanded={isOpen} onPress={onToggle} />
      </View>
    );
  }
  const draft = async () => {
    setBusy(true);
    setError(null);
    const err = await draftReply(action.threadId);
    setBusy(false);
    if (err) setError(err);
    else void onChanged();
  };
  return (
    <View style={styles.rowAction}>
      <TextLink label={busy ? "Drafting…" : error ? "Retry draft" : "Draft reply"} disabled={busy} onPress={() => void draft()} />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function DraftPanel({
  title,
  url,
  threadId,
  draft,
  banned,
  onChanged,
  onDismissed,
}: {
  title: string;
  url: string;
  threadId: string;
  draft: { text: string; state: string };
  banned: boolean;
  onChanged: () => Promise<unknown>;
  onDismissed: () => void;
}) {
  const styles = useStyles(makeStyles);
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState(draft.text);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<"edit" | "dismiss" | null>(null);
  useEffect(() => setText(draft.text), [draft.text]);
  const editBlocked = editing === null ? null : draftEditBlocked(editing);

  const copy = () => {
    try {
      Clipboard.setString(text);
      return true;
    } catch {
      return false;
    }
  };
  const post = () => {
    setError(null);
    if (banned) {
      setLine(BANNED_POST_LINE);
      return;
    }
    setLine(replyPasteHint(copy()));
    open(url);
  };
  const markPosted = async () => {
    setSaving(true);
    setError(null);
    const err = await markReplyPosted(threadId);
    setSaving(false);
    if (err) setError(err);
    else void onChanged();
  };
  const saveEdit = async () => {
    if (editing === null || editBlocked) return;
    setBusy("edit");
    setError(null);
    const err = await saveReplyDraft(threadId, editing);
    setBusy(null);
    if (err) setError(err);
    else {
      setText(editing.trim());
      setEditing(null);
      setLine("Draft saved.");
      void onChanged();
    }
  };
  const dismiss = async () => {
    setBusy("dismiss");
    setError(null);
    const err = await dismissReplyDraft(threadId);
    setBusy(null);
    if (err) setError(err);
    else {
      onDismissed();
      void onChanged();
    }
  };

  return (
    <View style={styles.draft}>
      <Text style={styles.draftTitle}>Drafted reply · edit it on Reddit before you post</Text>
      {title ? (
        <Text style={styles.small} numberOfLines={2}>
          {title}
        </Text>
      ) : null}
      {editing !== null ? (
        <>
          <ZaviTextField
            value={editing}
            onChangeText={setEditing}
            autoFocus
            minLines={5}
            maxLines={12}
            error={editing.trim().length > DRAFT_MAX_CHARS}
            accessibilityLabel="Edit draft"
            accessibilityHint="Up to 4,000 characters"
          />
          {editBlocked ? <Text style={styles.small}>{editBlocked}</Text> : null}
          <View style={styles.draftButtons}>
            <CardButton label={busy === "edit" ? "Saving…" : "Save"} onPress={() => void saveEdit()} disabled={!!editBlocked} busy={busy === "edit"} />
            <CardButton
              label="Cancel"
              variant="secondary"
              onPress={() => {
                setEditing(null);
                setError(null);
              }}
              disabled={busy === "edit"}
            />
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </>
      ) : (
        <>
          <Text style={styles.cellText} selectable>
            {text}
          </Text>
          <View style={styles.draftButtons}>
            <CardButton label="Post" onPress={post} />
            <CardButton
              label="Copy"
              variant="secondary"
              onPress={() => {
                setError(null);
                if (copy()) setLine("Copied.");
                else setError("Couldn't copy. Select the reply and copy it.");
              }}
            />
            {draft.state !== "posted" ? (
              <CardButton label={saving ? "Saving…" : "Mark as posted"} variant="secondary" onPress={() => void markPosted()} busy={saving} />
            ) : null}
            {draft.state !== "posted" ? (
              <CardButton
                label="Edit"
                variant="secondary"
                onPress={() => {
                  setError(null);
                  setLine(null);
                  setEditing(text);
                }}
                disabled={!!busy || saving}
              />
            ) : null}
            {draft.state !== "posted" ? (
              <CardButton
                label={busy === "dismiss" ? "Dismissing…" : "Dismiss"}
                variant="secondary"
                onPress={() => void dismiss()}
                disabled={!!busy || saving}
                busy={busy === "dismiss"}
              />
            ) : null}
          </View>
          {line ? <Text style={styles.small}>{line}</Text> : null}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scanWrap: { marginTop: space.md, gap: space.xs },
    scanRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
    scanPill: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      minHeight: 40,
      paddingHorizontal: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
    },
    dot: { width: 8, height: 8, borderRadius: 4 },
    scanText: { flexShrink: 1, fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    scanButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm },
    scanError: {
      padding: space.md,
      borderRadius: radius.sm,
      backgroundColor: colors.errorBg,
      fontFamily: font.family.medium,
      fontSize: 13,
      color: colors.ink,
    },
    pressed: { opacity: 0.7 },
    dim: { opacity: 0.5 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
    tile: {
      width: "48%",
      flexGrow: 1,
      gap: 0,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 12,
      backgroundColor: colors.panel,
    },
    tileOn: { borderColor: colors.ink },
    sectionTitle: { marginTop: space.lg, fontFamily: font.family.semi, fontSize: 17, letterSpacing: -0.2, color: colors.ink },
    tileHead: { flexDirection: "row", alignItems: "center", gap: 6 },
    tileLabel: { flex: 1, fontFamily: font.family.regular, fontSize: 11, lineHeight: 15, color: colors.muted },
    tileValueRow: { flexDirection: "row", alignItems: "baseline", gap: space.sm, flexWrap: "wrap" },
    tileValue: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 21, color: colors.ink },
    delta: { fontFamily: font.family.medium, fontSize: 11 },
    good: { color: colors.status.greenText },
    bad: { color: colors.status.redText },
    slot: { width: 56, height: 22, borderRadius: 4, backgroundColor: colors.soft },
    small: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    card: {
      marginTop: space.md,
      padding: space.lg,
      gap: space.sm,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 16,
      backgroundColor: colors.panel,
    },
    tableHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    tableTitle: { flex: 1, fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    emptyBox: {
      padding: space.md,
      borderRadius: radius.sm,
      backgroundColor: colors.soft,
      fontFamily: font.family.regular,
      fontSize: 13,
      lineHeight: 19,
      color: colors.muted,
    },
    bleed: { marginHorizontal: -space.lg },
    bleedInner: { paddingHorizontal: space.lg },
    grid: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden" },
    gridRow: { flexDirection: "row" },
    gridHead: { backgroundColor: colors.soft },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    cell: { paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
    cellDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
    headText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    footText: { fontFamily: font.family.semi, fontSize: 13, color: colors.textSecondary },
    right: { textAlign: "right" },
    cellText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    dimText: { color: colors.muted },
    linkCell: { gap: 3 },
    linkText: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    chip: {
      alignSelf: "flex-start",
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: radius.pill,
      overflow: "hidden",
      fontFamily: font.family.semi,
      fontSize: 12,
    },
    chipGood: { backgroundColor: colors.status.greenBg, color: colors.status.greenText },
    chipBad: { backgroundColor: colors.status.redBg, color: colors.status.redText },
    chipMuted: { backgroundColor: colors.soft, color: colors.textSecondary },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.lg },
    meterRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    meterTrack: { width: 44, height: 6, borderRadius: 3, backgroundColor: colors.soft, overflow: "hidden" },
    meterFill: { height: 6, borderRadius: 3, backgroundColor: colors.status.greenDot },
    select: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 4,
      minHeight: 32,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
    },
    errorText: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 17, color: colors.red },
    rowAction: { marginTop: 4, alignItems: "flex-start", gap: 2 },
    draft: { gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    draftTitle: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    draftButtons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  });
