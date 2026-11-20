import { forwardRef, useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "../../components/AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import { Icon } from "../../components/Icon";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { UnderlinedText } from "../../components/UnderlinedText";
import { ZaviTextField } from "../../components/ZaviTextField";
import {
  BackHeader,
  Message,
  PrimaryButton,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import { pickVideo } from "../../features/agents/attachPickers";
import {
  ImageAttachError,
  pickImages,
  type PickedImage,
} from "../../features/agents/uploadImage";
import {
  MAX_FEEDBACK_ATTACHMENTS,
  MAX_FEEDBACK_CHARS,
  hasFeedbackUploads,
  makeFeedbackAttachment,
  normalizeFeedbackPickError,
  readyFeedbackPaths,
  uploadFeedbackAttachment,
  useSubmitFeedback,
  type FeedbackAttachment,
  type FeedbackAttachmentKind,
} from "../../features/settings/feedback";
import { track } from "../../lib/analytics";
import { useReduceMotion } from "../../lib/motion";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export default function FeedbackScreen() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sheet = useRef<BottomSheetModal>(null);
  const submit = useSubmitFeedback();

  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const uploading = hasFeedbackUploads(attachments);

  function stage(kind: FeedbackAttachmentKind, file: PickedImage) {
    const next = makeFeedbackAttachment(kind, file);
    setError(null);
    setAttachments((list) => [...list, next]);
    void uploadFeedbackAttachment(next)
      .then((path) => {
        setAttachments((list) =>
          list.map((a) =>
            a.id === next.id ? { ...next, status: "ready", path } : a,
          ),
        );
      })
      .catch(() => {
        setAttachments((list) => list.filter((a) => a.id !== next.id));
        setError(`Couldn't upload ${next.name}.`);
      });
  }

  function handlePickError(e: unknown) {
    if (e instanceof ImageAttachError) {
      setError(normalizeFeedbackPickError(e.message));
      return;
    }
    setError("Couldn't attach that. Try again.");
  }

  async function addImages() {
    const slots = MAX_FEEDBACK_ATTACHMENTS - attachments.length;
    if (slots <= 0) {
      setError(`Up to ${MAX_FEEDBACK_ATTACHMENTS} attachments.`);
      return;
    }
    try {
      const picked = await pickImages(slots, (message) =>
        setError(normalizeFeedbackPickError(message)),
      );
      picked.forEach((file) => stage("image", file));
    } catch (e) {
      handlePickError(e);
    }
  }

  async function addVideo() {
    const slots = MAX_FEEDBACK_ATTACHMENTS - attachments.length;
    if (slots <= 0) {
      setError(`Up to ${MAX_FEEDBACK_ATTACHMENTS} attachments.`);
      return;
    }
    try {
      const picked = await pickVideo();
      if (picked) stage("video", picked);
    } catch (e) {
      handlePickError(e);
    }
  }

  async function send() {
    if (!body.trim() || uploading || submit.isPending) return;
    setError(null);
    try {
      await submit.mutateAsync({
        body,
        attachments: readyFeedbackPaths(attachments),
        source: "settings",
      });
      track("product_feedback_submitted");
      setSent(true);
      setBody("");
      setAttachments([]);
    } catch (e) {
      setError(feedbackSubmitError(e));
    }
  }

  function sendMore() {
    setSent(false);
    setError(null);
    submit.reset();
  }

  return (
    <Screen>
      <BackHeader title="Send feedback" />
      {sent ? (
        <View
          style={[
            settingsStyles.content,
            styles.success,
            { paddingBottom: insets.bottom + 20 },
          ]}
        >
          <View style={styles.successIcon}>
            <Icon
              name="check"
              size={26}
              color={colors.green}
              strokeWidth={2.2}
            />
          </View>
          <Text style={styles.successTitle}>Thanks, we have it.</Text>
          <Text style={styles.successBody}>
            It went to the Zavi team with your screenshots and recordings.
          </Text>
          <PrimaryButton
            label="Done"
            onPress={() => router.back()}
            style={styles.fullWidthButton}
          />
          <Pressable
            style={({ pressed }) => [
              styles.sendMore,
              pressed && styles.linkPressed,
            ]}
            onPress={sendMore}
            accessibilityRole="button"
          >
            <UnderlinedText style={styles.sendMoreText}>
              Send more
            </UnderlinedText>
          </Pressable>
        </View>
      ) : (
        <KeyboardAvoider style={styles.flex}>
          <TouchableWithoutFeedback
            onPress={Keyboard.dismiss}
            accessible={false}
          >
            <ScrollView
              contentContainerStyle={[
                settingsStyles.content,
                styles.content,
                { paddingBottom: insets.bottom + 20 },
              ]}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.intro}>
                Tell the Zavi team what is working, what is not, or what you
                wish it did instead. A screenshot or a short screen recording
                helps.
              </Text>

              <ZaviTextField
                value={body}
                onChangeText={(text) => {
                  setBody(text);
                  if (error) setError(null);
                }}
                minLines={4}
                maxLines={8}
                maxLength={MAX_FEEDBACK_CHARS}
                placeholder="What is working, what is not, what you wish it did instead."
                accessibilityLabel="Your feedback"
              />
              <Text style={styles.counter}>
                {body.length}/{MAX_FEEDBACK_CHARS}
              </Text>

              {attachments.length > 0 ? (
                <View style={styles.attachments}>
                  {attachments.map((a) => (
                    <AttachmentRow
                      key={a.id}
                      attachment={a}
                      onRemove={() =>
                        setAttachments((list) =>
                          list.filter((x) => x.id !== a.id),
                        )
                      }
                    />
                  ))}
                </View>
              ) : null}

              <Pressable
                style={({ pressed }) => [
                  styles.attachButton,
                  pressed &&
                    attachments.length < MAX_FEEDBACK_ATTACHMENTS &&
                    styles.attachButtonPressed,
                  attachments.length >= MAX_FEEDBACK_ATTACHMENTS && styles.off,
                ]}
                onPress={() => sheet.current?.present()}
                disabled={attachments.length >= MAX_FEEDBACK_ATTACHMENTS}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: attachments.length >= MAX_FEEDBACK_ATTACHMENTS,
                }}
              >
                <Icon name="paperclip" size={17} color={colors.ink} />
                <Text style={styles.attachButtonText}>
                  {`Attach screenshot or recording (${attachments.length}/${MAX_FEEDBACK_ATTACHMENTS})`}
                </Text>
              </Pressable>
              <Text style={styles.hint}>
                Images up to 5MB. Videos (mp4) up to 50MB.
              </Text>

              {error ? <Message tone="error">{error}</Message> : null}

              <PrimaryButton
                label="Send to Zavi team"
                busyLabel={uploading ? "Uploading…" : "Sending…"}
                busy={uploading || submit.isPending}
                disabled={!body.trim()}
                onPress={() => void send()}
                style={styles.fullWidthButton}
              />
            </ScrollView>
          </TouchableWithoutFeedback>
        </KeyboardAvoider>
      )}

      <AttachFeedbackSheet
        ref={sheet}
        onImage={() => void addImages()}
        onVideo={() => void addVideo()}
      />
    </Screen>
  );
}

function feedbackSubmitError(e: unknown): string {
  const message =
    e instanceof Error
      ? e.message.trim()
      : typeof e === "string"
        ? e.trim()
        : "";
  if (
    !message ||
    message.startsWith("{") ||
    /network request failed|failed to fetch/i.test(message)
  ) {
    return "Couldn't send that. Try again.";
  }
  return message;
}

function AttachmentRow({
  attachment,
  onRemove,
}: {
  attachment: FeedbackAttachment;
  onRemove: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.attachmentRow}>
      <View style={styles.attachmentChip}>
        <Icon
          name={attachment.kind === "image" ? "photo" : "video"}
          size={18}
          color={colors.ink}
        />
      </View>
      <View style={styles.attachmentText}>
        <Text style={styles.attachmentName} numberOfLines={1}>
          {attachment.name}
        </Text>
        <Text style={styles.attachmentMeta} numberOfLines={1}>
          {attachment.status === "uploading"
            ? "Uploading…"
            : attachment.sizeLabel}
        </Text>
      </View>
      {attachment.status === "uploading" ? (
        <ActivityIndicator
          size="small"
          color={colors.muted}
          style={styles.spinner}
        />
      ) : (
        <Pressable
          style={({ pressed }) => [
            styles.remove,
            pressed && styles.removePressed,
          ]}
          onPress={onRemove}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${attachment.name}`}
        >
          <Icon name="close" size={17} color={colors.ink} strokeWidth={2} />
        </Pressable>
      )}
    </View>
  );
}

const AttachFeedbackSheet = forwardRef<
  BottomSheetModal,
  {
    onImage: () => void;
    onVideo: () => void;
  }
>(function AttachFeedbackSheet({ onImage, onVideo }, ref) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...p}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  );
  const dismiss = useCallback(() => {
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  }, [ref]);

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
    >
      <BottomSheetView
        style={[
          styles.sheetContent,
          { paddingBottom: space.lg + insets.bottom },
        ]}
      >
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Attach</Text>
          <Pressable
            style={({ pressed }) => [
              styles.close,
              pressed && styles.removePressed,
            ]}
            onPress={dismiss}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
          </Pressable>
        </View>
        <SheetAction
          label="Screenshot from Photos"
          onPress={() => {
            dismiss();
            setTimeout(onImage, 350);
          }}
        />
        <SheetAction
          label="Screen recording from Photos"
          onPress={() => {
            dismiss();
            setTimeout(onVideo, 350);
          }}
        />
      </BottomSheetView>
    </BottomSheetModal>
  );
});

function SheetAction({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.sheetAction,
        pressed && styles.sheetActionPressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={styles.sheetActionText}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  content: { flexGrow: 1 },
  fullWidthButton: { width: "100%" },
  counter: {
    marginTop: space.xs,
    textAlign: "right",
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  attachments: { marginTop: space.sm, gap: space.sm },
  attachmentRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 11,
    padding: 10,
    backgroundColor: colors.bg,
  },
  attachmentChip: {
    width: 36,
    height: 36,
    borderRadius: 9,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentText: { flex: 1, minWidth: 0 },
  attachmentName: {
    fontFamily: font.family.semi,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  attachmentMeta: {
    marginTop: 2,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  spinner: { width: 24 },
  remove: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  removePressed: { opacity: 0.7 },
  attachButton: {
    marginTop: space.md,
    minHeight: 44,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.bg,
  },
  attachButtonPressed: { opacity: 0.8 },
  attachButtonText: {
    flexShrink: 1,
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
    textAlign: "center",
  },
  intro: {
    marginTop: space.xs,
    marginBottom: space.lg,
    fontFamily: font.family.regular,
    fontSize: 12,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
  hint: {
    marginTop: space.sm,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  off: { opacity: 0.4 },
  success: {
    flex: 1,
    alignItems: "center",
    paddingTop: 80,
  },
  successIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.avatarGreen,
    alignItems: "center",
    justifyContent: "center",
  },
  successTitle: {
    marginTop: space.lg,
    fontFamily: font.family.semi,
    fontSize: 16,
    lineHeight: 22,
    includeFontPadding: false,
    color: colors.ink,
    textAlign: "center",
  },
  successBody: {
    marginTop: space.sm,
    fontFamily: font.family.regular,
    fontSize: font.size.base,
    lineHeight: 20,
    includeFontPadding: false,
    color: colors.muted,
    textAlign: "center",
  },
  sendMore: { marginTop: space.md, alignSelf: "center" },
  linkPressed: { opacity: 0.7 },
  sendMoreText: {
    fontFamily: font.family.semi,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  sheetBg: { backgroundColor: colors.surfaceRaised, borderRadius: 22 },
  grabber: { width: 36, height: 4, backgroundColor: colors.borderRaised },
  sheetContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
    gap: space.sm,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    marginTop: space.xs,
    marginBottom: space.xs,
  },
  sheetTitle: {
    flex: 1,
    fontFamily: font.family.semi,
    fontSize: 16,
    lineHeight: 22,
    includeFontPadding: false,
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
  sheetAction: {
    minHeight: 46,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
    backgroundColor: colors.bg,
  },
  sheetActionPressed: { opacity: 0.8 },
  sheetActionText: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
});
