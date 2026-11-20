import { forwardRef, useCallback, type ComponentProps } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import type { Artifact } from "../../features/artifacts/types";
import { artifactFormat } from "./ArtifactPreviewTile";
import { ArtifactGlyph, type ArtifactGlyphName } from "./ArtifactGlyph";

export type ArtifactAction = "open" | "download" | "rename" | "delete";

const actions: readonly {
  key: ArtifactAction;
  label: string;
  icon: ArtifactGlyphName;
}[] = [
  { key: "open", label: "Open", icon: "eye" },
  { key: "download", label: "Download", icon: "download" },
  { key: "rename", label: "Rename", icon: "pencil" },
  { key: "delete", label: "Delete", icon: "trash" },
];

export const ArtifactActionSheet = forwardRef<BottomSheetModal, {
  artifact: Artifact | null;
  busyAction?: ArtifactAction | null;
  onOpen: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose?: () => void;
  onDismiss?: () => void;
}>(function ArtifactActionSheet(
  { artifact, busyAction = null, onOpen, onDownload, onRename, onDelete, onClose, onDismiss },
  ref,
) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const renderBackdrop = useCallback(
    (props: ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
    ),
    [],
  );

  const callbacks: Record<ArtifactAction, () => void> = {
    open: onOpen,
    download: onDownload,
    rename: onRename,
    delete: onDelete,
  };

  return (
    <BottomSheetModal
      ref={ref}
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handle}
      onDismiss={onDismiss}
    >
      <BottomSheetView style={[styles.content, { paddingBottom: space.lg + insets.bottom }]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              {artifact?.title ?? "Artifact options"}
            </Text>
            {artifact ? <Text style={styles.subtitle}>{artifactFormat(artifact)}</Text> : null}
          </View>
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <ArtifactGlyph name="close" size={22} color={colors.ink} />
          </Pressable>
        </View>
        <View style={styles.divider} />
        <View style={styles.actions}>
          {actions.map((action) => {
            const busy = busyAction === action.key;
            const disabled = !artifact || !!busyAction;
            return (
              <Pressable
                key={action.key}
                style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                onPress={callbacks[action.key]}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={`${action.label} ${artifact?.title ?? "artifact"}`}
                accessibilityState={{ disabled, busy }}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={action.key === "delete" ? colors.red : colors.ink} />
                ) : (
                  <ArtifactGlyph name={action.icon} size={20} color={action.key === "delete" ? colors.red : colors.ink} />
                )}
                <Text style={[styles.actionLabel, action.key === "delete" && styles.deleteLabel]}>
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBackground: {
    borderTopLeftRadius: 27,
    borderTopRightRadius: 27,
    backgroundColor: colors.surfaceRaised,
  },
  handle: {
    width: 35,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderRaised,
  },
  content: { paddingTop: space.sm },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.sm,
  },
  headerText: { flex: 1 },
  title: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: 18,
    lineHeight: 24,
    color: colors.ink,
  },
  subtitle: {
    marginTop: space.xs,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: font.size.sm,
    color: colors.muted,
  },
  closeButton: {
    width: 40,
    height: 40,
    marginTop: -space.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    height: 1,
    marginTop: space.md,
    backgroundColor: colors.line,
  },
  actions: { marginTop: space.md, paddingHorizontal: space.sm },
  action: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  actionPressed: { backgroundColor: colors.soft },
  actionLabel: {
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 16,
    color: colors.ink,
  },
  deleteLabel: { color: colors.red },
});
