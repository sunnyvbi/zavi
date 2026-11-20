import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  LayoutAnimation,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Icon } from "./Icon";
import { MicrophonePermissionDialog } from "./MicrophonePermissionDialog";
import { hintText } from "./ZaviTextField";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import type { Attachment } from "../features/agents/attachments";
import { useDictation } from "../features/voice/useDictation";

const ATTACH_SIZE = 30;
const SEND_SIZE = 34;
const COMPACT_LEFT_INSET = ATTACH_SIZE + space.sm;
const COMPACT_RIGHT_INSET = SEND_SIZE * 2 + space.sm * 2;
const LAYOUT_ANIMATION_CONFIG = {
  duration: 180,
  update: { type: LayoutAnimation.Types.easeInEaseOut },
};

export function Composer({
  value,
  onChangeText,
  onSend,
  sending,
  placeholder,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  onPreviewAttachment,
  attaching,
  uploading,
  voiceScopeKey,
  voiceEnabled,
  working,
  stopping,
  onStop,
  focusKey,
  menu,
  contextChips = [],
  blocked = false,
}: {
  value: string;
  onChangeText: (t: string) => void;
  onSend: () => void;
  sending: boolean;
  placeholder: string;
  attachments?: Attachment[];
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  onPreviewAttachment?: (attachment: Attachment) => void;
  attaching?: boolean;
  uploading?: boolean;
  voiceScopeKey: string;
  voiceEnabled: boolean;
  working?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  focusKey?: number;
  menu?: ReactNode;
  contextChips?: ContextChip[];
  blocked?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const focusAfterDictation = useRef<string | null>(null);
  const dictation = useDictation({
    scopeKey: voiceScopeKey,
    enabled: voiceEnabled && !sending && !attaching,
    onConfirm: (text) => {
      focusAfterDictation.current = voiceScopeKey;
      onChangeText(value ? `${value}${/\s$/.test(value) ? "" : " "}${text}` : text);
    },
  });
  useEffect(() => {
    if (focusKey) inputRef.current?.focus();
  }, [focusKey]);
  const voiceActive = dictation.phase !== "idle" && dictation.phase !== "permission";
  const voiceBusy = dictation.phase !== "idle";
  useEffect(() => {
    if (voiceActive) Keyboard.dismiss();
  }, [voiceActive]);
  useEffect(() => {
    if (voiceActive) return;
    if (voiceEnabled && focusAfterDictation.current === voiceScopeKey) {
      inputRef.current?.focus();
    }
    focusAfterDictation.current = null;
  }, [voiceActive, voiceEnabled, voiceScopeKey]);
  const hasSendable =
    value.trim().length > 0 ||
    attachments.some((a) => a.status === "ready") ||
    contextChips.some((c) => c.sendable);
  const canSend = hasSendable && !blocked && !sending && !uploading && !voiceActive;
  const [compactTextWidth, setCompactTextWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      {}
      {menu}
      <MicrophonePermissionDialog
        mode={dictation.permissionDialog}
        onRespond={dictation.respondToPermission}
      />
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {attachments.map((a) => (
            <View
              key={a.id}
              style={styles.chip}
              accessibilityLabel={
                a.status === "error"
                  ? `${a.name} — upload failed: ${a.message}`
                  : a.status === "uploading"
                    ? `${a.name} — uploading`
                    : `${a.name} — attached`
              }
            >
              <Pressable
                onPress={() => onPreviewAttachment?.(a)}
                disabled={!onPreviewAttachment || (a.kind === "doc" && a.status !== "error")}
                accessibilityRole="button"
                accessibilityLabel={
                  a.status === "error"
                    ? `${a.name} failed to upload. Try again or remove`
                    : a.kind === "doc"
                      ? undefined
                      : `Preview ${a.name}`
                }
              >
                <StagedPreview attachment={a} />
              </Pressable>
              {a.status === "uploading" ? (
                <View style={styles.thumbOverlay} pointerEvents="none">
                  <ActivityIndicator size="small" color={colors.ink} />
                </View>
              ) : null}
              {a.status === "error" ? (
                <View style={[styles.thumbOverlay, styles.errorScrim]} pointerEvents="none">
                  <View style={styles.errorBadge}>
                    <Text style={styles.errorMark}>!</Text>
                  </View>
                </View>
              ) : null}
              <Pressable
                style={styles.remove}
                onPress={() => onRemoveAttachment?.(a.id)}
                accessibilityLabel={`Remove ${a.name}`}
              >
                <Text style={styles.removeText}>×</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.bar}>
        <View style={[styles.field, voiceActive && styles.hiddenField]}>
          {contextChips.length > 0 ? (
            <View style={styles.contextChips}>
              {contextChips.map((c) => (
                <View key={c.key} style={[styles.contextChip, c.tone === "approval" && styles.approvalChip]}>
                  <Pressable
                    style={styles.contextChipBody}
                    onPress={c.onPress}
                    disabled={!c.onPress}
                    accessibilityRole={c.onPress ? "button" : undefined}
                    accessibilityLabel={c.label}
                  >
                    {c.icon}
                    <Text style={styles.contextChipText} numberOfLines={1}>
                      {c.label}
                    </Text>
                  </Pressable>
                  {c.onRemove ? (
                    <Pressable onPress={c.onRemove} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${c.label}`}>
                      <Icon name="close" size={14} color={colors.ink} strokeWidth={2} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
          <TextInput
            keyboardAppearance={keyboardAppearance}
            ref={inputRef}
            style={[styles.input, expanded ? styles.inputExpanded : styles.inputCompact]}
            placeholder={hintText(placeholder)}
            placeholderTextColor={colors.muted}
            cursorColor={colors.ink}
            selectionColor={textSelectionColor}
            selectionHandleColor={colors.ink}
            value={value}
            onChangeText={onChangeText}
            editable={!voiceActive}
            accessibilityLabel="Message Zavi"
            onLayout={(event) => {
              if (event.nativeEvent.layout.width === 0) return;
              const width = Math.max(
                0,
                Math.round(
                  event.nativeEvent.layout.width -
                    COMPACT_LEFT_INSET -
                    COMPACT_RIGHT_INSET,
                ),
              );
              setCompactTextWidth((current) => (current === width ? current : width));
            }}
            multiline
            textAlignVertical={expanded ? "top" : "center"}
          />
          <View
            style={[styles.actions, !expanded && styles.actionsCompact]}
            pointerEvents="box-none"
          >
            <Pressable
              style={[styles.attach, (attaching || voiceActive) && styles.attachBusy]}
              onPress={() => {
                Keyboard.dismiss();
                onAttach?.();
              }}
              disabled={attaching || !onAttach || voiceActive}
              accessibilityLabel="Add photos, video or files"
            >
              <Icon name="plus" size={22} color={colors.muted} strokeWidth={2} />
            </Pressable>
            <View style={styles.rightActions}>
              <Pressable
                style={[styles.mic, (!voiceEnabled || sending || attaching || voiceActive) && styles.attachBusy]}
                onPress={() => {
                  void dictation.start();
                }}
                disabled={!voiceEnabled || sending || attaching || voiceBusy}
                hitSlop={5}
                accessibilityRole="button"
                accessibilityLabel="Dictate message"
                accessibilityHint="Speak, then confirm the text before sending."
                accessibilityState={{ disabled: !voiceEnabled || sending || attaching || voiceBusy }}
              >
                <Icon name="mic" size={22} color={colors.muted} />
              </Pressable>
              {working ? (
                <Pressable
                  style={[styles.send, stopping && styles.sendDisabled]}
                  onPress={onStop}
                  disabled={stopping || !onStop}
                  accessibilityRole="button"
                  accessibilityLabel="Stop this run"
                  accessibilityState={{ disabled: !!stopping || !onStop }}
                >
                  {}
                  <View style={styles.stopMark} />
                </Pressable>
              ) : (
                <Pressable
                  style={[styles.send, !canSend && styles.sendDisabled]}
                  onPress={onSend}
                  disabled={!canSend}
                  accessibilityLabel="Send"
                >
                  <Icon name="arrowUp" size={18} color={colors.onInk} strokeWidth={2.5} />
                </Pressable>
              )}
            </View>
          </View>
          {compactTextWidth > 0 ? (
            <Text
              accessible={false}
              pointerEvents="none"
              style={[styles.measure, { width: compactTextWidth }]}
              onTextLayout={(event) => {
                const shouldExpand = value.length > 0 && event.nativeEvent.lines.length > 1;
                if (shouldExpand !== expanded) {
                  LayoutAnimation.configureNext(LAYOUT_ANIMATION_CONFIG);
                  setExpanded(shouldExpand);
                }
              }}
            >
              {value || " "}
            </Text>
          ) : null}
        </View>
        {voiceActive ? (
          <View style={styles.dictation}>
            <View style={styles.dictationHeading}>
              {dictation.phase === "starting" || dictation.phase === "stopping" ? (
                <ActivityIndicator size="small" color={colors.muted} />
              ) : (
                <Icon name="mic" size={18} color={dictation.phase === "listening" ? colors.red : colors.muted} />
              )}
              <Text style={styles.dictationStatus} accessibilityLiveRegion="polite">
                {dictation.phase === "starting"
                  ? "Starting microphone…"
                  : dictation.phase === "listening"
                    ? "Listening…"
                    : dictation.phase === "stopping"
                      ? "Finishing…"
                      : "Review your words"}
              </Text>
            </View>
            {dictation.transcript ? (
              <ScrollView style={styles.transcriptPreview} nestedScrollEnabled>
                <Text style={styles.transcript}>{dictation.transcript}</Text>
              </ScrollView>
            ) : (
              <Text style={styles.dictationHint}>Your words will appear here.</Text>
            )}
            <View style={styles.dictationActions}>
              <Pressable
                onPress={dictation.cancel}
                style={({ pressed }) => [styles.voiceAction, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Cancel dictation"
              >
                <Text style={styles.voiceActionText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={dictation.confirm}
                style={({ pressed }) => [
                  styles.voiceAction,
                  styles.confirmVoice,
                  (dictation.phase === "starting" || dictation.phase === "stopping") && styles.attachBusy,
                  pressed && styles.pressed,
                ]}
                disabled={dictation.phase === "starting" || dictation.phase === "stopping"}
                accessibilityRole="button"
                accessibilityLabel="Use dictated text"
                accessibilityState={{ disabled: dictation.phase === "starting" || dictation.phase === "stopping" }}
              >
                <Icon name="check" size={18} color={colors.onInk} />
                <Text style={styles.confirmVoiceText}>Use text</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {dictation.error ? (
          <View style={styles.voiceError}>
            <Text style={styles.errorText} accessibilityRole="alert">{dictation.error}</Text>
            {dictation.canOpenSettings ? (
              <Pressable
                onPress={() => {
                  void dictation.start();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.voiceActionText}>Open settings</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export type ContextChip = {
  key: string;
  label: string;
  icon?: ReactNode;
  onPress?: () => void;
  tone?: "approval";
  sendable?: boolean;
  onRemove?: () => void;
};

function StagedPreview({ attachment: a }: { attachment: Attachment }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const dim = [
    a.status === "uploading" && styles.thumbBusy,
    a.status === "error" && styles.thumbError,
  ];
  if (a.kind === "image" && a.previewUri) {
    return <Image source={{ uri: a.previewUri }} style={[styles.thumb, ...dim]} contentFit="cover" />;
  }
  if (a.kind === "video") {
    return (
      <View style={[styles.thumb, styles.videoThumb, ...dim]}>
        <Icon name="video" size={20} color={colors.onInk} />
      </View>
    );
  }
  const ext = a.name.includes(".") ? a.name.split(".").pop()!.toUpperCase().slice(0, 4) : "FILE";
  return (
    <View style={[styles.thumb, styles.docThumb, ...dim]}>
      <Icon name="file" size={18} color={colors.muted} />
      <Text style={styles.docExt}>{ext}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  contextChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 2, paddingBottom: 4 },
  contextChip: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 3,
    paddingRight: 10,
    height: 24,
    borderRadius: radius.pill,
    backgroundColor: colors.mentionChipBg,
  },
  approvalChip: {
    paddingLeft: 8,
    borderWidth: 1,
    borderColor: colors.approvalBorder,
    backgroundColor: colors.approvalBg,
  },
  contextChipBody: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  contextChipText: {
    flexShrink: 1,
    fontSize: font.size.md,
    lineHeight: 18,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    color: colors.ink,
  },
  chips: { gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm },
  chip: { position: "relative" },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.soft },
  videoThumb: { backgroundColor: "#111", alignItems: "center", justifyContent: "center" },
  docThumb: { alignItems: "center", justifyContent: "center", gap: 2, borderWidth: 1, borderColor: colors.line },
  docExt: { fontSize: 9, fontFamily: font.family.semi, color: colors.muted },
  thumbBusy: { opacity: 0.45 },
  thumbError: { borderWidth: 1.5, borderColor: colors.red },
  thumbOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  errorScrim: { borderRadius: radius.sm, backgroundColor: "rgba(0,0,0,0.45)" },
  errorBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.redFill,
    borderWidth: 2,
    borderColor: colors.onInk,
    alignItems: "center",
    justifyContent: "center",
  },
  errorMark: { color: colors.onAccent, fontSize: 14, lineHeight: 16, fontFamily: font.family.bold },
  remove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  removeText: { color: colors.onInk, fontSize: 13, fontWeight: "900", lineHeight: 15 },
  bar: { paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md },
  field: {
    position: "relative",
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.borderRaised,
    borderRadius: radius.lg + 9,
    backgroundColor: colors.surfaceRaised,
  },
  attach: {
    width: ATTACH_SIZE,
    height: SEND_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  attachBusy: { opacity: 0.4 },
  rightActions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  mic: { width: SEND_SIZE, height: SEND_SIZE, alignItems: "center", justifyContent: "center" },
  hiddenField: { display: "none" },
  dictation: {
    gap: space.md,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colors.borderRaised,
    borderRadius: radius.lg + 9,
    backgroundColor: colors.surfaceRaised,
  },
  dictationHeading: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dictationStatus: { flex: 1, color: colors.ink, includeFontPadding: false, fontFamily: font.family.medium, fontSize: font.size.base },
  dictationHint: { color: colors.muted, includeFontPadding: false, fontFamily: font.family.regular, fontSize: font.size.base, lineHeight: 22 },
  transcript: { color: colors.ink, includeFontPadding: false, fontFamily: font.family.regular, fontSize: font.size.base, lineHeight: 22 },
  transcriptPreview: { maxHeight: 120 },
  dictationActions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md },
  voiceAction: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceActionText: { color: colors.muted, includeFontPadding: false, fontFamily: font.family.medium, fontSize: font.size.base },
  confirmVoice: { flexDirection: "row", gap: space.sm, backgroundColor: colors.ink },
  confirmVoiceText: { color: colors.onInk, includeFontPadding: false, fontFamily: font.family.medium, fontSize: font.size.base },
  pressed: { opacity: 0.7 },
  voiceError: { gap: space.xs, paddingTop: space.sm },
  errorText: { color: colors.red, includeFontPadding: false, fontFamily: font.family.regular, fontSize: font.size.sm },
  input: {
    width: "100%",
    minHeight: 30,
    maxHeight: 120,
    paddingTop: 6,
    paddingBottom: 6,
    fontSize: 15,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    color: colors.ink,
  },
  inputCompact: {
    height: SEND_SIZE,
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: COMPACT_LEFT_INSET,
    paddingRight: COMPACT_RIGHT_INSET,
  },
  inputExpanded: { paddingHorizontal: space.xs },
  actions: {
    minHeight: SEND_SIZE,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  actionsCompact: {
    position: "absolute",
    right: space.sm,
    bottom: 6,
    left: space.sm,
  },
  send: {
    width: SEND_SIZE,
    height: SEND_SIZE,
    borderRadius: SEND_SIZE / 2,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.25 },
  stopMark: { width: 12, height: 12, borderRadius: 3, backgroundColor: colors.onInk },
  measure: {
    position: "absolute",
    top: 0,
    left: 0,
    opacity: 0,
    fontSize: font.size.base,
    fontFamily: font.family.medium,
    includeFontPadding: false,
  },
});
