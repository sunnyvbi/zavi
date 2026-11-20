import { forwardRef, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "./AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./Icon";
import { ConnectorTile } from "./connections/ConnectorLogo";
import { useReduceMotion } from "../lib/motion";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export type AttachChoice = "photos" | "camera" | "video" | "files" | "library" | "repo";

const OPTIONS: { key: AttachChoice; icon?: IconName; label: string; hint: string }[] = [
  { key: "photos", icon: "photo", label: "Photos", hint: "PNG, JPEG or WebP · up to 5MB" },
  { key: "camera", icon: "camera", label: "Camera", hint: "Take a photo" },
  { key: "video", icon: "video", label: "Video", hint: "One MP4 or MOV · up to 50MB" },
  { key: "files", icon: "file", label: "Files", hint: "PDF, DOCX, CSV or TXT · up to 10MB" },
  { key: "library", icon: "library", label: "A file Zavi already has", hint: "Reports, sheets and images from your chats" },
  { key: "repo", label: "GitHub repo", hint: "The repo agents work in" },
];

export const AttachSheet = forwardRef<
  BottomSheetModal,
  {
    onChoose: (choice: AttachChoice) => void;
    disabled?: Partial<Record<AttachChoice, boolean>>;
    hints?: Partial<Record<AttachChoice, string>>;
    hidden?: Partial<Record<AttachChoice, boolean>>;
  }
>(function AttachSheet({ onChoose, disabled, hints, hidden }, ref) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();

  const dismiss = useCallback(() => {
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  }, [ref]);

  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );

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
      <BottomSheetView style={[styles.content, { paddingBottom: space.lg + insets.bottom }]}>
        <View style={styles.head}>
          <Text style={styles.title}>Add to message</Text>
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

        {OPTIONS.filter((o) => !hidden?.[o.key]).map((o) => {
          const off = !!disabled?.[o.key];
          return (
            <Pressable
              key={o.key}
              style={({ pressed }) => [styles.action, pressed && !off && styles.actionPressed, off && styles.off]}
              onPress={() => {
                if (off) return;
                dismiss();
                setTimeout(() => onChoose(o.key), 350);
              }}
              accessibilityRole="button"
              accessibilityState={{ disabled: off }}
              accessibilityHint={hints?.[o.key] ?? o.hint}
            >
              {o.icon ? (
                <View style={styles.iconBox}>
                  <Icon name={o.icon} size={20} color={colors.ink} />
                </View>
              ) : (
                <ConnectorTile slug="github" label="GitHub" size={40} />
              )}
              <View style={styles.text}>
                <Text style={styles.label}>{o.label}</Text>
                <Text style={styles.hint} numberOfLines={1}>
                  {off ? "Limit reached for this message" : hints?.[o.key] ?? o.hint}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </BottomSheetView>
    </BottomSheetModal>
  );
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBg: { backgroundColor: colors.surfaceRaised, borderRadius: 27 },
  grabber: { width: 35, height: 4, backgroundColor: colors.borderRaised },
  content: { paddingHorizontal: 15, paddingTop: space.xs },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    marginHorizontal: space.sm,
    marginTop: space.xs,
    marginBottom: space.md,
  },
  title: {
    flex: 1,
    fontSize: font.size.title,
    fontFamily: font.family.bold,
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
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    padding: space.sm,
    borderRadius: space.md,
  },
  actionPressed: { backgroundColor: colors.soft },
  off: { opacity: 0.4 },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { flex: 1, minWidth: 0 },
  label: { fontSize: 16, fontFamily: font.family.medium, color: colors.ink },
  hint: { marginTop: 2, fontSize: font.size.sm, color: colors.muted },
});
