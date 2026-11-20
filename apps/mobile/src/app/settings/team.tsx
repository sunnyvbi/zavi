import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import { Avatar } from "../../components/Avatar";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import {
  BackHeader,
  Badge,
  Intro,
  ListGroup,
  Message,
  SecondaryButton,
  SectionLabel,
  settingsStyles,
  useSettingsToast,
} from "../../components/settings/SettingsUI";
import { AgentInboxAddresses } from "../../components/settings/AgentInboxAddresses";
import { MemberSheet } from "../../components/settings/MemberSheet";
import { TeamInviteButtonSkeleton, TeamInvitesSkeleton, TeamMembersSkeleton, TeamSectionLabelSkeleton } from "../../components/settings/TeamSkeleton";
import { TransferOwnershipDialog } from "../../components/settings/TransferOwnershipDialog";
import { friendlyError } from "../../components/ErrorCard";
import { roleLabel } from "../../components/settings/WorkspaceSheet";
import { useAuth } from "../../auth/AuthProvider";
import { track } from "../../lib/analytics";
import {
  useCanManage,
  useInvites,
  useIsOwner,
  useMembers,
  useRemoveMember,
  useRevokeInvite,
  useSetMemberRole,
  useTransferOwnership,
  type EditableRole,
  type Invite,
  type Member,
} from "../../features/settings/api";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const PREVIEW_SKELETON = false;

type BusyAction = "role" | "remove" | "transfer" | null;

const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2, viewer: 3 };

export default function Team() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const canManage = useCanManage();
  const isOwner = useIsOwner();
  const membersQ = useMembers();
  const invitesQ = useInvites(canManage);
  const setMemberRole = useSetMemberRole();
  const removeMember = useRemoveMember();
  const transferOwnership = useTransferOwnership();
  const revoke = useRevokeInvite();
  const { show, toast } = useSettingsToast();
  const sheetRef = useRef<BottomSheetModal>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Invite | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const myId = session?.user?.id;

  const members = useMemo(
    () =>
      [...(membersQ.data ?? [])].sort(
        (a, b) =>
          (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.email.localeCompare(b.email),
      ),
    [membersQ.data],
  );
  const invites = invitesQ.data ?? [];
  const selectedMember = selectedId ? members.find((m) => m.user_id === selectedId) ?? null : null;

  function runRevoke() {
    const invite = revokeTarget;
    setRevokeTarget(null);
    if (!invite) return;
    revoke.mutate(invite.id, {
      onSuccess: () => track("invite_revoked"),
      onError: (e) => show(friendlyError(e, "Couldn't revoke the invite. Try again.")),
    });
  }

  function openMember(member: Member) {
    setSelectedId(member.user_id);
    setSheetError(null);
    setTransferError(null);
    sheetRef.current?.present();
  }

  function handleSheetDismiss() {
    setSelectedId(null);
    setSheetError(null);
    setTransferError(null);
  }

  function openRemoveConfirm() {
    if (busy) return;
    setSheetError(null);
    setTransferError(null);
    setRemoveOpen(true);
  }

  function closeRemoveConfirm() {
    if (busy) return;
    setRemoveOpen(false);
    setSheetError(null);
  }

  function openTransferDialog() {
    if (busy) return;
    setSheetError(null);
    setTransferError(null);
    setTransferOpen(true);
  }

  function closeTransferDialog() {
    if (busy) return;
    setTransferOpen(false);
    setTransferError(null);
    setSheetError(null);
  }

  async function onSaveRole(role: EditableRole) {
    const member = selectedMember;
    if (!member || busy) return;
    setBusy("role");
    setSheetError(null);
    try {
      await setMemberRole.mutateAsync({ userId: member.user_id, role });
      track("member_role_changed", { role });
      setBusy(null);
      sheetRef.current?.dismiss();
      show(`${member.email} is now ${role === "admin" ? "an" : "a"} ${role}.`);
    } catch (e) {
      setSheetError(friendlyError(e, "Couldn't change role. Try again."));
      setBusy(null);
    }
  }

  async function confirmRemove() {
    const member = selectedMember;
    if (!member || busy) {
      if (!busy) setRemoveOpen(false);
      return;
    }
    setRemoveOpen(false);
    setBusy("remove");
    setSheetError(null);
    try {
      await removeMember.mutateAsync(member.user_id);
      track("member_removed");
      setBusy(null);
      sheetRef.current?.dismiss();
      show(`${member.email} was removed from the workspace.`);
    } catch (e) {
      setBusy(null);
      setSheetError(friendlyError(e, "Couldn't revoke member. Try again."));
    }
  }

  async function confirmTransfer() {
    const member = selectedMember;
    if (!member || busy) {
      if (!busy) setTransferOpen(false);
      return;
    }
    setBusy("transfer");
    setTransferError(null);
    try {
      await transferOwnership.mutateAsync(member.user_id);
      track("ownership_transferred");
      setBusy(null);
      setTransferOpen(false);
      setTransferError(null);
      sheetRef.current?.dismiss();
      show(`${member.email} is now the owner.`);
    } catch (e) {
      setTransferError(friendlyError(e, "Ownership transfer failed; no change was made."));
      setBusy(null);
    }
  }

  const hint = isOwner
    ? "Tap a teammate to change their role, remove them, or hand over ownership."
    : "Tap a teammate to remove them. Only the owner changes roles.";

  return (
    <Screen>
      <BackHeader title="Members" />
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
      >
        <Intro>Keep the people who can act on your behalf clear.</Intro>

        {membersQ.isLoading || PREVIEW_SKELETON ? <TeamSectionLabelSkeleton /> : (
          <SectionLabel first>
            {members.length > 0 ? `Members · ${members.length}` : "Members"}
          </SectionLabel>
        )}
        {membersQ.isLoading || PREVIEW_SKELETON ? (
          <TeamMembersSkeleton />
        ) : membersQ.isError ? (
          <Message tone="error">Couldn't load your members. Go back and try again.</Message>
        ) : (
          <>
            <ListGroup>
              {members.map((member, index) => {
                const isSelf = member.user_id === myId;
                const tappable = canManage && member.role !== "owner" && !isSelf;
                return (
                  <MemberRow
                    key={member.user_id}
                    index={index}
                    member={member}
                    isSelf={isSelf}
                    tappable={tappable}
                    onPress={() => openMember(member)}
                  />
                );
              })}
            </ListGroup>
            {canManage ? <Text style={styles.hint}>{hint}</Text> : null}
          </>
        )}

        {canManage ? (
          <>
            {invitesQ.isLoading || PREVIEW_SKELETON ? <TeamSectionLabelSkeleton /> : <SectionLabel>Pending invites</SectionLabel>}
            {invitesQ.isLoading || PREVIEW_SKELETON ? (
              <TeamInvitesSkeleton />
            ) : invitesQ.isError ? (
              <Message tone="error">Couldn't load invites.</Message>
            ) : invites.length === 0 ? (
              <View style={styles.emptyInvites}>
                <Text style={styles.emptyInvitesText}>
                  No pending invites. Invite someone and they show here until they join.
                </Text>
              </View>
            ) : (
              <ListGroup>
                {invites.map((invite, index) => (
                  <InviteRow
                    key={invite.id}
                    index={index}
                    invite={invite}
                    disabled={revoke.isPending}
                    onRevoke={() => setRevokeTarget(invite)}
                  />
                ))}
              </ListGroup>
            )}
            {invitesQ.isLoading || PREVIEW_SKELETON ? (
              <TeamInviteButtonSkeleton />
            ) : (
              <SecondaryButton
                label="Invite a teammate"
                icon="plus"
                onPress={() => router.push("/settings/invite")}
              />
            )}
          </>
        ) : (
          <View style={styles.locked}>
            <Icon name="lock" size={15} color={colors.muted} />
            <Text style={styles.lockedText}>Only owners and admins can manage members.</Text>
          </View>
        )}
        <AgentInboxAddresses onCopied={show} />
      </ScrollView>

      <MemberSheet
        ref={sheetRef}
        member={selectedMember}
        isOwner={isOwner}
        busy={busy}
        error={sheetError}
        onSaveRole={onSaveRole}
        onRemove={openRemoveConfirm}
        onTransfer={openTransferDialog}
        onDismiss={handleSheetDismiss}
      />
      <ConfirmDialog
        visible={removeOpen}
        icon="trash"
        title="Remove member?"
        message={
          <>
            {"Remove "}
            <Text style={{ fontFamily: font.family.semi, color: colors.ink }}>
              {selectedMember?.email ?? ""}
            </Text>
            {"? They lose access immediately. Their past runs stay visible to owners and admins."}
          </>
        }
        cancelLabel="Cancel"
        confirmLabel="Remove"
        destructive
        onCancel={closeRemoveConfirm}
        onConfirm={() => void confirmRemove()}
      />
      <ConfirmDialog
        visible={!!revokeTarget}
        icon="trash"
        title="Revoke invite?"
        message={`${revokeTarget?.email ?? ""} won't be able to join with this invite.`}
        cancelLabel="Cancel"
        confirmLabel="Revoke"
        destructive
        onCancel={() => setRevokeTarget(null)}
        onConfirm={runRevoke}
      />
      <TransferOwnershipDialog
        visible={transferOpen}
        member={selectedMember}
        busy={busy === "transfer"}
        error={transferError}
        onCancel={closeTransferDialog}
        onConfirm={() => void confirmTransfer()}
      />
      {toast}
    </Screen>
  );
}

function MemberRow({
  index,
  member,
  isSelf,
  tappable,
  onPress,
}: {
  index: number;
  member: Member;
  isSelf: boolean;
  tappable: boolean;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const body = (
    <>
      <TeamAvatar member={member} />
      <View style={styles.memberText}>
        <View style={styles.nameLine}>
          <Text style={styles.email} numberOfLines={1}>
            {member.email}
          </Text>
          {isSelf ? <Text style={styles.you}>You</Text> : null}
        </View>
      </View>
      <Badge tone={member.role === "owner" ? "ink" : "neutral"}>{roleLabel(member.role)}</Badge>
      {tappable ? (
        <View style={styles.chevronRight}>
          <Icon name="chevron" size={18} color={colors.muted} />
        </View>
      ) : null}
    </>
  );

  if (!tappable) {
    return <View style={[styles.row, index > 0 && styles.rowDivider]}>{body}</View>;
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.row, index > 0 && styles.rowDivider, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Manage ${member.email}`}
    >
      {body}
    </Pressable>
  );
}

function InviteRow({
  index,
  invite,
  disabled,
  onRevoke,
}: {
  index: number;
  invite: Invite;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.row, styles.inviteRow, index > 0 && styles.rowDivider]}>
      <Avatar slug={invite.email} name={invite.email} size={36} round />
      <View style={styles.memberText}>
        <Text style={styles.email} numberOfLines={1}>
          {invite.email}
        </Text>
        <View style={styles.inviteMeta}>
          <Badge tone="amber">Pending</Badge>
          <Text style={styles.inviteRole}>{roleLabel(invite.role)}</Text>
        </View>
      </View>
      <Pressable
        onPress={onRevoke}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Revoke invite for ${invite.email}`}
        disabled={disabled}
        style={({ pressed }) => [styles.revokeButton, pressed && !disabled && styles.revokePressed]}
      >
        <Text style={[styles.revoke, disabled && styles.disabled]}>Revoke</Text>
      </Pressable>
    </View>
  );
}

function TeamAvatar({ member }: { member: Member }) {
  const styles = useStyles(makeStyles);
  if (member.role !== "owner") {
    return <Avatar slug={member.user_id} name={member.email} size={36} round />;
  }

  return (
    <View style={styles.ownerAvatar}>
      <Text style={styles.ownerInitials}>{initials(member.email)}</Text>
    </View>
  );
}

function initials(email: string) {
  const name = email.split("@")[0] ?? email;
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0] ?? ""}${parts[1][0] ?? ""}` : name.slice(0, 2);
  return letters.toUpperCase();
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 60,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    backgroundColor: colors.panel,
  },
  inviteRow: { minHeight: 72, paddingVertical: 14 },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  rowPressed: { backgroundColor: colors.soft },
  memberText: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  email: {
    flexShrink: 1,
    fontFamily: font.family.medium,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  you: {
    flexShrink: 0,
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
  chevronRight: { flexShrink: 0, transform: [{ rotate: "-90deg" }] },
  hint: {
    marginTop: space.sm,
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
  emptyInvites: {
    marginTop: space.sm,
    padding: space.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.line,
    borderRadius: radius.lg,
  },
  emptyInvitesText: {
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
  locked: {
    marginTop: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    backgroundColor: colors.panel,
  },
  lockedText: {
    flex: 1,
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
  inviteMeta: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  inviteRole: {
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.textSecondary,
  },
  revokeButton: {
    flexShrink: 0,
    height: 32,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  revokePressed: { opacity: 0.7 },
  revoke: {
    fontFamily: font.family.semi,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.red,
  },
  disabled: { opacity: 0.4 },
  ownerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.ink,
  },
  ownerInitials: {
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.onInk,
  },
});
