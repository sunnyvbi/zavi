import { useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Clipboard, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "../Icon";
import { UnderlinedText } from "../UnderlinedText";
import { PrimaryButton, SecondaryButton } from "../settings/SettingsUI";
import { showDialog } from "../DialogHost";
import { useSetup } from "../../features/setup/SetupProvider";
import { deleteImport, uploadImport } from "../../features/setup/api";
import {
  admitPicked,
  PICK_TYPES,
  rowLabel,
  summarizeReads,
  type ImportFile,
  type LocalRow,
  type PickedFile,
} from "../../features/setup/imports";
import * as copy from "../../features/setup/copy";
import { FooterRow, SetupFrame, StatusPill } from "./SetupUI";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type DocPicker = typeof import("expo-document-picker");
function docPicker(): DocPicker | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-document-picker") as DocPicker;
  } catch {
    return null;
  }
}

type Row = { key: string; name: string; status: ImportFile["status"] | LocalRow["status"]; facts?: number; reason?: string; truncated?: boolean; server?: boolean };

export function ImportStep({
  header,
  reopened,
  onFinish,
  onSkip,
  skipBody,
  backStep,
}: {
  header: ReactNode;
  reopened: boolean;
  onFinish: () => Promise<void> | void;
  onSkip: () => Promise<void> | void;
  skipBody: string;
  backStep: number;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const setup = useSetup();
  const files = setup.imports.files ?? [];
  const reads = summarizeReads(files);
  const [local, setLocal] = useState<LocalRow[]>([]);
  const [storedAny, setStoredAny] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [codingOpen, setCodingOpen] = useState(false);
  const [showPrompt, setShowPrompt] = useState(true);
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false);

  const pick = async () => {
    if (busyRef.current) return;
    setNotice(null);
    const picker = docPicker();
    if (!picker) {
      setNotice(copy.PICKER_MISSING);
      return;
    }
    let picked: PickedFile[];
    try {
      const result = await picker.getDocumentAsync({ type: PICK_TYPES, multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      picked = result.assets.map((a) => ({ uri: a.uri, name: a.name ?? "file", size: a.size ?? null, mime: a.mimeType ?? null }));
    } catch {
      setNotice(copy.PICKER_MISSING);
      return;
    }
    if (picked.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    const { rows, dropped } = admitPicked(picked);
    if (dropped > 0) setNotice(copy.ONLY_FIRST(rows.length));
    setLocal(rows.map(({ file: _f, ...r }) => r));
    let stored = 0;
    let failed = rows.filter((r) => r.status === "failed").length;
    try {
      await setup.sequence(async (same) => {
        for (const row of rows) {
          if (row.status !== "waiting" || !row.file) continue;
          if (!same()) return;
          const out = await uploadImport(row.file);
          if (out.ok) {
            stored += 1;
            setLocal((list) => list.filter((x) => x.key !== row.key));
          } else {
            failed += 1;
            setLocal((list) => list.map((x) => (x.key === row.key ? { key: x.key, name: x.name, status: "failed", reason: out.reason } : x)));
          }
        }
        if (stored > 0 && same()) {
          setStoredAny(true);
          await setup.imports.refresh();
          if (failed === 0 && !reopened && same()) await onFinish();
        }
      });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const skip = async () => {
    const ok = await showDialog({
      title: copy.SKIP1_TITLE,
      message: skipBody,
      confirmLabel: copy.SKIP_YES,
      cancelLabel: copy.SKIP_NO,
    });
    if (ok) await onSkip();
  };

  const remove = async (row: Row) => {
    if (!row.server) {
      setLocal((list) => list.filter((x) => x.key !== row.key));
      return;
    }
    const ok = await showDialog({
      title: copy.removeFileTitle(row.name),
      message: copy.REMOVE_FILE_BODY,
      confirmLabel: copy.REMOVE_FILE_YES,
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    setNotice(null);
    setRemoving(row.key);
    try {
      const out = await deleteImport(row.key);
      if (!out.ok) {
        setNotice(out.reason);
        return;
      }
      setStoredAny(false);
      await setup.imports.refresh();
    } finally {
      setRemoving(null);
    }
  };

  const rows: Row[] = [
    ...local,
    ...files.map((f): Row => ({ key: f.id, name: f.filename, status: f.status, facts: f.facts, reason: f.reason, truncated: f.truncated, server: true })),
  ];
  const keysRows = files.filter((f) => f.redactions > 0);
  const canFinish = files.length > 0 || storedAny;

  const footer = reopened ? (
    <FooterRow>
      <SecondaryButton label={copy.CHOOSE_FILES} onPress={() => { Keyboard.dismiss(); void pick(); }} disabled={busy} style={styles.half} />
      <PrimaryButton label={files.length === 0 ? copy.backToStep(backStep) : "Done"} onPress={() => { Keyboard.dismiss(); void onFinish(); }} disabled={busy} style={styles.half} />
    </FooterRow>
  ) : canFinish ? (
    <FooterRow>
      <SecondaryButton label={copy.CHOOSE_FILES} onPress={() => { Keyboard.dismiss(); void pick(); }} disabled={busy} style={styles.half} />
      <PrimaryButton label={copy.CONTINUE} onPress={() => { Keyboard.dismiss(); void onFinish(); }} disabled={busy} style={styles.half} />
    </FooterRow>
  ) : (
    <FooterRow>
      <SecondaryButton label={copy.SKIP_STEP} onPress={() => { Keyboard.dismiss(); void skip(); }} disabled={busy} style={styles.half} />
      <PrimaryButton label={copy.CHOOSE_FILES} onPress={() => { Keyboard.dismiss(); void pick(); }} busy={busy} busyLabel="Adding…" style={styles.half} />
    </FooterRow>
  );

  return (
    <SetupFrame header={header} footer={footer}>
      <Pressable
        onPress={() => { Keyboard.dismiss(); void pick(); }}
        disabled={busy}
        style={({ pressed }) => [styles.pickCard, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${copy.PICK_TITLE}. ${copy.PICK_LIMITS}`}
      >
        <View style={styles.pickIcon}>
          {busy ? <ActivityIndicator color={colors.ink} /> : <Icon name="upload" size={20} color={colors.ink} />}
        </View>
        <View style={styles.flex}>
          <Text style={styles.pickTitle}>{copy.PICK_TITLE}</Text>
          <Text style={styles.meta}>{copy.PICK_LIMITS}</Text>
        </View>
      </Pressable>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      {rows.length > 0 ? (
        <View style={styles.list}>
          {rows.map((r, i) => (
            <View key={r.key} style={[styles.fileRow, i > 0 && styles.divider]}>
              <View style={styles.fileIcon}>
                <Icon name={r.status === "stored" ? "image" : "file"} size={16} color={colors.textSecondary} />
              </View>
              <View style={styles.flex}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {r.name}
                </Text>
                {r.truncated ? <Text style={styles.meta}>{copy.TRUNCATED_LINE}</Text> : null}
              </View>
              <StatusPill
                label={rowLabel(r)}
                tone={r.status === "done" ? "ok" : r.status === "failed" || r.status === "stored" ? "warn" : "neutral"}
              />
              {r.server || r.status === "failed" ? (
                <Pressable
                  onPress={() => { Keyboard.dismiss(); void remove(r); }}
                  disabled={busy || removing !== null}
                  style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${r.name}`}
                >
                  {removing === r.key ? (
                    <ActivityIndicator size="small" color={colors.ink} />
                  ) : (
                    <Icon name="close" size={12} color={colors.ink} strokeWidth={2.2} />
                  )}
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {keysRows.map((f) => (
        <View key={f.id} style={styles.keysNote} accessibilityRole="text">
          <Icon name="key" size={15} color={colors.ink} />
          <Text style={styles.keysText}>{copy.keysRemovedLine(f.redactions, f.filename)}</Text>
        </View>
      ))}
      {reads.done.length > 0 ? (
        <Text style={styles.learned}>
          <Text style={styles.learnedStrong}>{copy.learnedLine(reads.facts, reads.done.length)}</Text> {copy.LEARNED_WHERE}
        </Text>
      ) : null}

      {}
      <Pressable
        onPress={() => { Keyboard.dismiss(); setCodingOpen((v) => !v); }}
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: codingOpen }}
        hitSlop={6}
      >
        <Text style={styles.link}>{copy.CODING_TOOL_TOGGLE}</Text>
        <View style={codingOpen ? styles.chevronOpen : null}>
          <Icon name="chevronDown" size={18} color={colors.ink} strokeWidth={2} />
        </View>
      </Pressable>
      {codingOpen ? (
        <View style={styles.coding}>
          <View style={styles.codingHeader}>
            <Text style={styles.codingTitle}>{copy.BUNDLE_TITLE}</Text>
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                Clipboard.setString(copy.BUNDLE_PROMPT);
                setCopied(true);
              }}
              style={({ pressed }) => [styles.copyPromptButton, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <View style={styles.copyPromptContent}>
                {copied ? <Icon name="check" size={14} color={colors.ink} /> : null}
                <Text style={styles.copyPromptText}>{copied ? copy.COPIED : copy.COPY_PROMPT}</Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => { Keyboard.dismiss(); setShowPrompt((v) => !v); }}
              accessibilityRole="button"
              accessibilityState={{ expanded: showPrompt }}
              hitSlop={8}
            >
              <UnderlinedText style={styles.promptToggleText}>{showPrompt ? copy.HIDE_PROMPT : copy.SEE_PROMPT}</UnderlinedText>
            </Pressable>
          </View>
          <Text style={styles.meta}>{copy.BUNDLE_HELP}</Text>
          {showPrompt ? (
            <View style={styles.promptBox}>
              <ScrollView
                style={styles.promptScrollView}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                contentContainerStyle={styles.promptScroll}
              >
                <Text style={styles.prompt} selectable>
                  {copy.BUNDLE_PROMPT}
                </Text>
              </ScrollView>
            </View>
          ) : null}
        </View>
      ) : null}
    </SetupFrame>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1, minWidth: 0 },
    half: { flex: 1, marginTop: 0, minHeight: 48, borderRadius: radius.md },
    pressed: { opacity: 0.8 },
    pickCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      borderWidth: 1.5,
      borderStyle: "dashed",
      borderColor: colors.line,
      borderRadius: radius.lg,
      backgroundColor: colors.soft,
      padding: radius.lg,
    },
    pickIcon: {
      width: 44,
      height: 44,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.bg,
      alignItems: "center",
      justifyContent: "center",
    },
    pickTitle: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
    meta: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    notice: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.red, marginTop: space.lg },
    list: { marginTop: space.lg, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, overflow: "hidden" },
    fileRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.md },
    divider: { borderTopWidth: 1, borderTopColor: colors.line },
    fileIcon: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: colors.soft,
      alignItems: "center",
      justifyContent: "center",
    },
    fileName: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
    removeButton: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.soft,
      alignItems: "center",
      justifyContent: "center",
    },
    keysNote: {
      flexDirection: "row",
      gap: space.sm,
      marginTop: space.lg,
      borderRadius: radius.md,
      backgroundColor: colors.status.amberBg,
      padding: space.md,
    },
    keysText: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.ink },
    learned: { marginTop: space.lg, fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
    learnedStrong: { fontFamily: font.family.semi, color: colors.ink },
    toggle: { marginTop: space.xl, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space.xs },
    link: { flexShrink: 1, fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    chevronOpen: { transform: [{ rotate: "180deg" }] },
    coding: { marginTop: space.md, gap: space.md },
    codingHeader: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
    codingTitle: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
    copyPromptButton: {
      height: 36,
      paddingHorizontal: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.bg,
      alignItems: "center",
      justifyContent: "center",
    },
    copyPromptContent: { flexDirection: "row", alignItems: "center", gap: 6 },
    copyPromptText: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    promptToggleText: { fontFamily: font.family.semi, fontSize: 13, color: colors.textSecondary },
    promptBox: {
      height: 220,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.md,
      backgroundColor: colors.soft,
      overflow: "hidden",
    },
    promptScrollView: { flex: 1 },
    promptScroll: { padding: radius.md },
    prompt: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 12, lineHeight: 18, color: colors.ink },
  });
