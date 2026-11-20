import { useMemo, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { CHANNELS } from "@zavi/shared";
import { Screen } from "../../components/Screen";
import { Icon } from "../../components/Icon";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ZaviTextField } from "../../components/ZaviTextField";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SkeletonBlock } from "../../components/Skeleton";
import { CardButton, errorText } from "../../components/reply/ui";
import { RuleScopeSheet } from "../../components/settings/RuleScopeSheet";
import {
  BackHeader,
  ListGroup,
  PillSwitch,
  PrimaryButton,
  Row,
  SectionLabel,
  settingsStyles,
  useSettingsToast,
} from "../../components/settings/SettingsUI";
import { useAgents } from "../../features/agents/hooks";
import { pickerAgentName } from "../../features/agents/pickerAgents";
import { useMyRole } from "../../features/settings/api";
import { ApiFetchError } from "../../lib/api";
import {
  RULE_CAP,
  RULE_MAX,
  parseScope,
  ruleMeta,
  ruleRights,
  scopeKey,
  scopeLabel,
  scopeOptions,
  splitRules,
  useRuleAction,
  useRules,
  type Rule,
  type RuleAction,
} from "../../features/settings/rules";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Editing = { id: string; text: string; scope: string };

export default function RulesScreen() {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const rulesQ = useRules();
  const action = useRuleAction();
  const agentsQ = useAgents();
  const myRole = useMyRole();
  const { show, toast } = useSettingsToast(space.lg);
  const scopeSheet = useRef<BottomSheetModal>(null);

  const [draft, setDraft] = useState("");
  const [draftScope, setDraftScope] = useState("all");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [scopeFor, setScopeFor] = useState<"draft" | "edit">("draft");
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);

  const data = rulesQ.data;
  const { canManage, canSuggest } = ruleRights(data?.role ?? myRole);
  const { active, pending } = splitRules(data);
  const busy = action.isPending;

  const options = useMemo(
    () => scopeOptions((agentsQ.data ?? []).map((a) => a.slug), CHANNELS, pickerAgentName),
    [agentsQ.data],
  );
  const label = (key: string) =>
    scopeLabel(key, { channel: (s) => CHANNELS.find((c) => c.slug === s)?.name, agent: pickerAgentName });

  async function run(a: RuleAction, fallback: string, done?: string): Promise<boolean> {
    try {
      await action.mutateAsync(a);
      if (done) show(done);
      return true;
    } catch (e) {
      const status = e instanceof ApiFetchError ? ` (${e.status})` : "";
      show(errorText(e, `${fallback}${status}`));
      return false;
    }
  }

  async function add() {
    const text = draft.trim();
    if (!text || busy) return;
    Keyboard.dismiss();
    const ok = await run(
      { kind: "add", text, scope: parseScope(draftScope) },
      "Could not save the rule.",
      canManage ? "Rule saved" : "Sent to your admin",
    );
    if (ok) setDraft("");
  }

  async function saveEdit() {
    if (!editing || !editing.text.trim() || busy) return;
    Keyboard.dismiss();
    const ok = await run(
      { kind: "edit", id: editing.id, text: editing.text.trim(), scope: parseScope(editing.scope) },
      "Could not save the change.",
      "Rule updated",
    );
    if (ok) setEditing(null);
  }

  function openScope(target: "draft" | "edit") {
    Keyboard.dismiss();
    setScopeFor(target);
    scopeSheet.current?.present();
  }

  const scopeValue = scopeFor === "edit" && editing ? editing.scope : draftScope;

  return (
    <Screen>
      <BackHeader title="Rules" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.intro}>
            Every agent a rule applies to follows it from its next run. A rule never approves a change or spends
            money on its own.
          </Text>

          {!data && rulesQ.isLoading ? (
            <View style={styles.loading}>
              <SkeletonBlock height={96} radius={16} />
              <SkeletonBlock height={160} radius={16} />
            </View>
          ) : !data ? (
            <View style={styles.failed}>
              <Text style={styles.muted}>Could not load your rules.</Text>
              <CardButton label="Retry" variant="secondary" onPress={() => void rulesQ.refetch()} />
            </View>
          ) : (
            <>
              <SectionLabel first right={<Text style={styles.count}>{`${active.length} of ${RULE_CAP}`}</Text>}>
                Active rules
              </SectionLabel>
              {active.length === 0 ? (
                <Text style={styles.empty}>
                  {`No rules yet.${canSuggest ? " Add one below, or type /feedback in any agent's chat." : ""}`}
                </Text>
              ) : (
                <ListGroup>
                  {active.map((r, i) =>
                    editing?.id === r.id ? (
                      <View key={r.id} style={[styles.item, i > 0 && styles.divider]}>
                        <ZaviTextField
                          value={editing.text}
                          onChangeText={(text) => setEditing({ ...editing, text })}
                          maxLength={RULE_MAX}
                          minLines={2}
                          maxLines={5}
                          accessibilityLabel="Edit rule"
                          autoFocus
                        />
                        <ScopeButton label={label(editing.scope)} onPress={() => openScope("edit")} />
                        <View style={styles.actions}>
                          <CardButton
                            label="Save"
                            busy={busy}
                            disabled={!editing.text.trim()}
                            onPress={() => void saveEdit()}
                          />
                          <CardButton label="Cancel" variant="plain" onPress={() => setEditing(null)} />
                        </View>
                      </View>
                    ) : (
                      <RuleItem
                        key={r.id}
                        rule={r}
                        meta={ruleMeta(r, label(scopeKey(r.scope_kind, r.scope_slug)))}
                        divider={i > 0}
                        trailing={
                          canManage ? (
                            <View style={styles.icons}>
                              <IconButton
                                icon="edit"
                                label={`Edit rule: ${r.text}`}
                                disabled={busy}
                                onPress={() =>
                                  setEditing({ id: r.id, text: r.text, scope: scopeKey(r.scope_kind, r.scope_slug) })
                                }
                              />
                              <IconButton
                                icon="trash"
                                label={`Delete rule: ${r.text}`}
                                disabled={busy}
                                danger
                                onPress={() => setDeleting(r)}
                              />
                            </View>
                          ) : null
                        }
                      />
                    ),
                  )}
                </ListGroup>
              )}

              {canSuggest ? (
                <>
                  <SectionLabel>{canManage ? "Add a rule" : "Suggest a rule"}</SectionLabel>
                  <ZaviTextField
                    value={draft}
                    onChangeText={setDraft}
                    maxLength={RULE_MAX}
                    minLines={2}
                    maxLines={5}
                    placeholder="For example: Never post on weekends."
                    accessibilityLabel={canManage ? "Add a rule" : "Suggest a rule"}
                  />
                  <Text style={styles.counter}>{`${draft.length}/${RULE_MAX}`}</Text>
                  <ScopeButton label={label(draftScope)} onPress={() => openScope("draft")} />
                  <PrimaryButton
                    label={canManage ? "Save rule" : "Suggest to your admin"}
                    busyLabel="Saving…"
                    busy={busy && !!draft.trim()}
                    disabled={!draft.trim()}
                    onPress={() => void add()}
                    style={styles.save}
                  />
                </>
              ) : null}

              <SectionLabel>Waiting for approval</SectionLabel>
              <Text style={styles.sectionNote}>
                {canManage
                  ? "Suggestions from your team and from what you told Zavi. Nothing here is followed until you save it."
                  : "An owner or admin decides which of these become rules."}
              </Text>
              {pending.length === 0 ? (
                <Text style={styles.empty}>Nothing waiting.</Text>
              ) : (
                <ListGroup>
                  {pending.map((r, i) => (
                    <RuleItem
                      key={r.id}
                      rule={r}
                      meta={ruleMeta(r, label(scopeKey(r.scope_kind, r.scope_slug)))}
                      divider={i > 0}
                      footer={
                        canManage ? (
                          <View style={styles.actions}>
                            <CardButton
                              label="Save rule"
                              disabled={busy}
                              onPress={() =>
                                void run({ kind: "activate", id: r.id }, "Could not save the rule.", "Rule saved")
                              }
                            />
                            <CardButton
                              label="Not a rule"
                              variant="secondary"
                              disabled={busy}
                              onPress={() => void run({ kind: "dismiss", id: r.id }, "Could not dismiss it.")}
                            />
                          </View>
                        ) : null
                      }
                    />
                  ))}
                </ListGroup>
              )}

              {canManage ? (
                <>
                  <SectionLabel>Suggestions</SectionLabel>
                  <ListGroup>
                    <Row
                      label="Pause suggestions"
                      sub="Zavi stops offering to keep things you say as rules. Your saved rules still apply."
                      role="switch"
                      state={{ checked: data.suggestions_paused, disabled: busy }}
                      onPress={() =>
                        void run({ kind: "pause", paused: !data.suggestions_paused }, "Could not change this.")
                      }
                      trailing={<PillSwitch value={data.suggestions_paused} />}
                    />
                    <Row
                      label="Delete all rules"
                      destructive
                      chevron={false}
                      state={{ disabled: busy || data.rules.length === 0 }}
                      onPress={() => setDeletingAll(true)}
                    />
                  </ListGroup>
                </>
              ) : null}

              {!canSuggest ? (
                <Text style={styles.viewer}>Viewers can read the rules but not add or change them.</Text>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoider>

      <RuleScopeSheet
        ref={scopeSheet}
        value={scopeValue}
        agents={options.agents}
        channels={options.channels}
        onPick={(key) => {
          if (scopeFor === "edit") setEditing((e) => (e ? { ...e, scope: key } : e));
          else setDraftScope(key);
        }}
      />
      <ConfirmDialog
        visible={deleting !== null}
        icon="trash"
        title="Delete this rule?"
        message={deleting ? `"${deleting.text}"` : ""}
        cancelLabel="Keep it"
        confirmLabel="Delete"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const r = deleting;
          setDeleting(null);
          if (r) void run({ kind: "delete", id: r.id }, "Could not delete the rule.", "Rule deleted");
        }}
      />
      <ConfirmDialog
        visible={deletingAll}
        icon="trash"
        title="Delete all rules?"
        message="Delete every rule and suggestion? This cannot be undone."
        cancelLabel="Cancel"
        confirmLabel="Delete all"
        destructive
        onCancel={() => setDeletingAll(false)}
        onConfirm={() => {
          setDeletingAll(false);
          void run({ kind: "deleteAll" }, "Could not delete your rules.", "All rules deleted");
        }}
      />
      {toast}
    </Screen>
  );
}

function RuleItem({
  rule,
  meta,
  divider,
  trailing,
  footer,
}: {
  rule: Rule;
  meta: string;
  divider: boolean;
  trailing?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.item, divider && styles.divider]}>
      <View style={styles.itemRow}>
        <View style={styles.itemText}>
          <Text style={styles.ruleText}>{rule.text}</Text>
          <Text style={styles.meta}>{meta}</Text>
          {rule.excerpt ? <Text style={styles.excerpt}>{`“${rule.excerpt}”`}</Text> : null}
        </View>
        {trailing}
      </View>
      {footer}
    </View>
  );
}

function ScopeButton({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.scope, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Applies to ${label}. Change`}
    >
      <Text style={styles.scopeLabel}>Applies to</Text>
      <Text style={styles.scopeValue} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.chevronDown}>
        <Icon name="chevronDown" size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
}

function IconButton({
  icon,
  label,
  onPress,
  disabled,
  danger,
}: {
  icon: "edit" | "trash";
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.iconButton, (pressed || disabled) && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon name={icon} size={18} color={danger ? colors.red : colors.textSecondary} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  intro: {
    marginBottom: space.sm,
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  loading: { gap: space.md, marginTop: space.md },
  failed: { marginTop: space.md, gap: space.sm, alignItems: "flex-start" },
  muted: { fontFamily: font.family.regular, fontSize: 14, color: colors.textSecondary },
  count: { fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
  empty: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: 16,
    backgroundColor: colors.soft,
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
    overflow: "hidden",
  },
  sectionNote: {
    marginTop: -space.xs,
    marginBottom: space.md,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  item: { paddingHorizontal: space.md, paddingVertical: space.md, gap: space.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.wire.line },
  itemRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  itemText: { flex: 1, minWidth: 0, gap: 3 },
  ruleText: { fontFamily: font.family.medium, fontSize: 15, lineHeight: 21, color: colors.ink },
  meta: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 16, color: colors.muted },
  excerpt: { fontFamily: font.family.regular, fontStyle: "italic", fontSize: 12, lineHeight: 17, color: colors.muted },
  icons: { flexDirection: "row", gap: 2 },
  iconButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  counter: {
    alignSelf: "flex-end",
    marginTop: space.xs,
    fontFamily: font.family.regular,
    fontSize: 12,
    color: colors.muted,
  },
  scope: {
    marginTop: space.sm,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: radius.pill,
    backgroundColor: colors.panel,
  },
  scopeLabel: { fontFamily: font.family.regular, fontSize: 13, color: colors.muted },
  scopeValue: { flex: 1, fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
  chevronDown: { marginLeft: "auto" },
  pressed: { opacity: 0.6 },
  save: { marginTop: space.md },
  viewer: {
    marginTop: space.lg,
    fontFamily: font.family.regular,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary,
  },
});
