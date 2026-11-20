import { forwardRef, useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetTextInput,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "./AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./Icon";
import {
  THREAD_TITLE_MAX,
  useDeleteThread,
  usePinnedThreads,
  useRenameThread,
  useTogglePin,
} from "../features/agents/threadActions";
import { useReduceMotion } from "../lib/motion";
import { chatShareUrl } from "../lib/webLink";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import { ErrorCard, friendlyError } from "./ErrorCard";
import { FocusRing } from "./ZaviTextField";

type SheetView = "menu" | "rename" | "delete";

export const ThreadActionsSheet = forwardRef<
  BottomSheetModal,
  {
    slug: string;
    threadId: string | undefined;
    title: string;
    onDeleted: () => void;
  }
>(function ThreadActionsSheet({ slug, threadId, title, onDeleted }, ref) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const [view, setView] = useState<SheetView>("menu");
  const [name, setName] = useState(title);
  const [error, setError] = useState<string | null>(null);

  const pins = usePinnedThreads();
  const togglePin = useTogglePin();
  const rename = useRenameThread(slug);
  const remove = useDeleteThread(slug);
  const pinned = !!threadId && (pins.data ?? []).includes(threadId);

  useEffect(() => setName(title), [title]);

  const dismiss = useCallback(() => {
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  }, [ref]);

  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );

  async function onShare() {
    if (!threadId) return;
    const link = chatShareUrl(threadId, slug);
    setError(null);
    try {
      await Share.share(Platform.OS === "ios" ? { url: link } : { message: link });
      dismiss();
    } catch (e) {
      setError(friendlyError(e, "Couldn't open sharing. Try again."));
    }
  }

  function onPin() {
    if (!threadId) return;
    togglePin.mutate(threadId);
    dismiss();
  }

  async function onSaveName() {
    const next = name.trim();
    if (!next) {
      setError("Enter a name.");
      return;
    }
    if (!threadId) return;
    setError(null);
    try {
      await rename.mutateAsync({ threadId, title: next });
      dismiss();
    } catch (e) {
      setError(friendlyError(e, "Couldn't rename this chat. Try again."));
    }
  }

  async function onConfirmDelete() {
    if (!threadId) return;
    setError(null);
    try {
      await remove.mutateAsync(threadId);
      dismiss();
      onDeleted();
    } catch (e) {
      setError(friendlyError(e, "Couldn't delete this chat. Try again."));
    }
  }

  const heading = view === "rename" ? "Rename chat" : view === "delete" ? "Delete chat?" : title;

  const onSheetChange = useBackClosesSheet();
  return (
    <BottomSheetModal
      ref={ref}
      onChange={onSheetChange}
      enableDynamicSizing
      enablePanDownToClose
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
      handleIndicatorStyle={styles.grabber}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      onDismiss={() => {
        setView("menu");
        setError(null);
        setName(title);
      }}
    >
      <BottomSheetView style={[styles.content, { paddingBottom: space.lg + insets.bottom }]}>
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={2}>
            {heading}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            onPress={dismiss}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
          </Pressable>
        </View>

        {view === "menu" ? (
          <>
            {}
            {threadId ? (
              <Action
                icon="share"
                label="Share"
                sub="Only you can open this link, signed in. Teammates in your workspace can't see this chat."
                onPress={() => void onShare()}
              />
            ) : null}
            <Action icon="pin" label={pinned ? "Unpin" : "Pin"} onPress={onPin} />
            <Action icon="rename" label="Rename" onPress={() => setView("rename")} />
            <Action icon="trash" label="Delete" danger onPress={() => setView("delete")} />
            {error ? <ErrorCard message={error} /> : null}
          </>
        ) : null}

        {view === "rename" ? (
          <>
            <Text style={styles.label}>Name</Text>
            <FocusRing radius={13}>
              {(focus) => (
                <BottomSheetTextInput
                  keyboardAppearance={keyboardAppearance}
                  style={styles.input}
                  value={name}
                  onChangeText={(t) => {
                    setName(t);
                    setError(null);
                  }}
                  maxLength={THREAD_TITLE_MAX}
                  autoFocus
                  selectTextOnFocus
                  returnKeyType="done"
                  onSubmitEditing={() => void onSaveName()}
                  selectionColor={textSelectionColor}
                  cursorColor={colors.ink}
                  selectionHandleColor={colors.ink}
                  placeholderTextColor={colors.muted}
                  placeholder="Chat name"
                  onFocus={() => focus.onFocus()}
                  onBlur={() => focus.onBlur()}
                />
              )}
            </FocusRing>
            {error ? <ErrorCard message={error} /> : null}
            <Pill
              label={rename.isPending ? "Saving…" : "Save"}
              tone="primary"
              disabled={rename.isPending}
              onPress={() => void onSaveName()}
            />
          </>
        ) : null}

        {view === "delete" ? (
          <>
            <Text style={styles.body}>
              {`Delete “${title}”? This removes the conversation from your chats.`}
            </Text>
            {error ? <ErrorCard message={error} /> : null}
            <Pill
              label={remove.isPending ? "Deleting…" : "Delete"}
              tone="danger"
              disabled={remove.isPending}
              onPress={() => void onConfirmDelete()}
            />
          </>
        ) : null}
      </BottomSheetView>
    </BottomSheetModal>
  );
});

function Action({
  icon,
  label,
  sub,
  onPress,
  danger,
}: {
  icon: IconName;
  label: string;
  sub?: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const tint = danger ? colors.danger : colors.ink;
  return (
    <Pressable
      style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={sub}
    >
      <Icon name={icon} size={20} color={tint} />
      {sub ? (
        <View style={styles.actionLabel}>
          <Text style={[styles.actionText, { color: tint }]}>{label}</Text>
          <Text style={styles.actionSub}>{sub}</Text>
        </View>
      ) : (
        <Text style={[styles.actionText, { color: tint }]}>{label}</Text>
      )}
    </Pressable>
  );
}

function Pill({
  label,
  onPress,
  tone,
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone: "primary" | "danger";
  disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.pill,
        tone === "primary" ? styles.pillPrimary : styles.pillDanger,
        (pressed || disabled) && styles.pillPressed,
      ]}
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
    >
      <Text style={[styles.pillText, tone !== "primary" && styles.pillTextOnAccent]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBg: { backgroundColor: colors.surfaceRaised, borderRadius: 27 },
  grabber: { width: 35, height: 4, backgroundColor: colors.borderRaised },
  content: { paddingHorizontal: 15, paddingTop: space.xs },
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    marginHorizontal: space.sm,
    marginTop: space.xs,
    marginBottom: 15,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: font.size.title,
    fontFamily: font.family.bold,
    includeFontPadding: false,
    letterSpacing: -0.5,
    color: colors.ink,
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  closePressed: { opacity: 0.7 },
  action: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    padding: space.md,
    borderRadius: space.md,
  },
  actionPressed: { backgroundColor: colors.soft },
  actionText: { fontSize: 16, includeFontPadding: false, fontFamily: font.family.medium },
  actionLabel: { flex: 1, minWidth: 0, gap: 2 },
  actionSub: {
    fontSize: font.size.sm,
    lineHeight: 17,
    includeFontPadding: false,
    fontFamily: font.family.regular,
    color: colors.muted,
  },
  pill: {
    marginTop: 18,
    minHeight: 47,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  pillPrimary: { backgroundColor: colors.ink },
  pillDanger: { backgroundColor: colors.dangerFill },
  pillPressed: { opacity: 0.8 },
  pillText: { fontSize: font.size.base, includeFontPadding: false, fontFamily: font.family.medium, color: colors.onInk },
  pillTextOnAccent: { color: colors.onAccent },
  label: { fontFamily: font.family.medium, marginHorizontal: space.sm, marginBottom: 9, fontSize: 14, color: colors.ink },
  input: {
    fontFamily: font.family.medium,
    padding: 13,
    fontSize: 15,
    color: colors.ink,
  },
  body: {
    marginHorizontal: space.sm,
    fontSize: font.size.base,
    lineHeight: 22,
    color: colors.muted,
  },
});
