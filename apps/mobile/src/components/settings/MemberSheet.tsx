import { forwardRef, useCallback, useEffect, useState } from "react";
import type { ComponentProps } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "../AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { ROLE_HELP } from "../../features/settings/api";
import type { EditableRole, Member } from "../../features/settings/api";
import { useReduceMotion } from "../../lib/motion";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Message, PrimaryButton, SecondaryButton, SectionLabel, Segmented } from "./SettingsUI";
import { roleLabel } from "./WorkspaceSheet";

type Props = {
  member: Member | null;
  isOwner: boolean;
  busy: "role" | "remove" | "transfer" | null;
  error: string | null;
  onSaveRole: (role: EditableRole) => void;
  onRemove: () => void;
  onTransfer: () => void;
  onDismiss: () => void;
};

const ROLE_OPTIONS: { value: EditableRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];

export const MemberSheet = forwardRef<BottomSheetModal, Props>(function MemberSheet(
  { member, isOwner, busy, error, onSaveRole, onRemove, onTransfer, onDismiss },
  ref,
) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const currentRole = member ? editableRole(member.role) : "member";
  const [selectedState, setSelectedState] = useState<{ memberId: string | null; role: EditableRole }>({
    memberId: null,
    role: currentRole,
  });
  const selected =
    member && selectedState.memberId === member.user_id ? selectedState.role : currentRole;
  const joined = formatJoinedDate(member?.joined_at);
  const subtitle = member ? `${roleLabel(member.role)}${joined ? ` · joined ${joined}` : ""}` : "";

  useEffect(() => {
    setSelectedState({ memberId: member?.user_id ?? null, role: currentRole });
  }, [currentRole, member?.user_id]);

  const renderBackdrop = useCallback(
    (p: ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...p}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior={busy === null ? "close" : "none"}
      />
    ),
    [busy],
  );

  const close = () => {
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  };

  const onSheetChange = useBackClosesSheet();
  return (
    <BottomSheetModal
      ref={ref}
      onChange={onSheetChange}
      enableDynamicSizing
      maxDynamicContentSize={560}
      enablePanDownToClose={busy === null}
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
      handleStyle={styles.handle}
      handleIndicatorStyle={styles.handleIndicator}
      onDismiss={onDismiss}
    >
      {member ? (
        <BottomSheetScrollView
          contentContainerStyle={[styles.content, { paddingBottom: 20 + insets.bottom }]}
        >
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title} numberOfLines={1}>
                {member.email}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.close,
                pressed && styles.closePressed,
                busy !== null && styles.closeDisabled,
              ]}
              onPress={close}
              disabled={busy !== null}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
              accessibilityState={{ disabled: busy !== null }}
            >
              <Icon name="close" size={16} color={colors.ink} strokeWidth={2} />
            </Pressable>
          </View>

          {isOwner ? (
            <>
              <SectionLabel first>Role</SectionLabel>
              <Segmented
                label="Role"
                value={selected}
                onChange={(role) => setSelectedState({ memberId: member.user_id, role })}
                options={ROLE_OPTIONS}
              />
              <Text style={styles.help}>{ROLE_HELP[selected]}</Text>
              <PrimaryButton
                label="Save role"
                busyLabel="Saving…"
                busy={busy === "role"}
                disabled={selected === currentRole || busy !== null}
                onPress={() => onSaveRole(selected)}
              />
            </>
          ) : (
            <View style={styles.ownerNote}>
              <Text style={styles.ownerNoteText}>Only the owner can change roles.</Text>
            </View>
          )}

          {error ? <Message tone="error">{error}</Message> : null}

          <View style={styles.actions}>
            {isOwner && (member.role === "admin" || member.role === "member") ? (
              <SecondaryButton
                label="Transfer ownership"
                onPress={onTransfer}
                disabled={busy !== null}
                style={styles.actionButton}
              />
            ) : null}
            <SecondaryButton
              label={busy === "remove" ? "Removing…" : "Remove member"}
              onPress={onRemove}
              danger
              disabled={busy !== null}
              style={styles.actionButton}
            />
          </View>

          {isOwner && member.role === "viewer" ? (
            <Text style={styles.transferHint}>
              Make them an admin or member first to hand over ownership.
            </Text>
          ) : null}
        </BottomSheetScrollView>
      ) : null}
    </BottomSheetModal>
  );
});

function editableRole(role: Member["role"]): EditableRole {
  if (role === "admin" || role === "viewer") return role;
  return "member";
}

function formatJoinedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBg: {
    backgroundColor: colors.surfaceRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  handle: { paddingTop: space.sm, paddingBottom: space.sm },
  handleIndicator: { width: 30, height: 4, borderRadius: radius.pill, backgroundColor: colors.borderRaised },
  content: { paddingHorizontal: space.lg, paddingTop: space.xs },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: font.family.semi,
    fontSize: 16,
    lineHeight: 22,
    includeFontPadding: false,
    color: colors.ink,
  },
  subtitle: {
    marginTop: 4,
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
  close: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  closePressed: { opacity: 0.7 },
  closeDisabled: { opacity: 0.4 },
  help: {
    marginTop: space.sm,
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.textSecondary,
  },
  ownerNote: {
    marginTop: space.md,
    borderRadius: 11,
    backgroundColor: colors.soft,
    padding: space.md,
  },
  ownerNoteText: {
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
  actions: { marginTop: 20, gap: space.sm },
  actionButton: { marginTop: 0 },
  transferHint: {
    marginTop: space.sm,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
});
