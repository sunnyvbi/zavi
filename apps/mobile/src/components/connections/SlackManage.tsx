import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Icon } from "../Icon";
import { FocusRing } from "../ZaviTextField";
import { ErrorLine } from "../reply/ui";
import {
  SLACK_PURPOSES,
  fetchVisibleAgentSlugs,
  openConnectFlow,
  saveSlackWorkspaceMeta,
} from "../../features/connectors/manage";
import type { SlackWorkspace } from "../../features/connectors/useConnections";
import { friendlyError } from "../ErrorCard";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const nameOf = (w: SlackWorkspace) => w.label || w.team_name || w.team_id;

export function SlackManage({
  workspaces,
  canManage,
  onChanged,
}: {
  workspaces: SlackWorkspace[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [openTeam, setOpenTeam] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    fetchVisibleAgentSlugs()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [canManage]);

  async function addWorkspace() {
    setAdding(true);
    setAddError(null);
    try {
      await openConnectFlow("slack");
      onChanged();
    } catch (e) {
      setAddError(friendlyError(e, "Couldn't start the Slack connection. Please try again."));
    } finally {
      setAdding(false);
    }
  }

  const count = workspaces.length;
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.headText}>{`Slack · ${count} workspace${count === 1 ? "" : "s"} connected`}</Text>
      </View>

      <View style={styles.list}>
        {workspaces.map((w) => (
          <WorkspaceRow
            key={w.team_id}
            ws={w}
            agents={agents}
            canManage={canManage}
            open={openTeam === w.team_id}
            onToggle={() => setOpenTeam((cur) => (cur === w.team_id ? null : w.team_id))}
            onSaved={onChanged}
          />
        ))}
      </View>

      {canManage ? (
        <>
          <Pressable
            style={({ pressed }) => [styles.add, (pressed || adding) && styles.dim]}
            onPress={() => void addWorkspace()}
            disabled={adding}
            accessibilityRole="button"
          >
            {adding ? <ActivityIndicator size="small" color={colors.wire.ink} /> : <Icon name="plus" size={16} color={colors.wire.ink} />}
            <Text style={styles.addText}>Add Slack workspace</Text>
          </Pressable>
          <Text style={styles.hint}>Each workspace you add stacks — it never replaces the ones above.</Text>
          <ErrorLine message={addError} />
        </>
      ) : null}
    </View>
  );
}

function WorkspaceRow({
  ws,
  agents,
  canManage,
  open,
  onToggle,
  onSaved,
}: {
  ws: SlackWorkspace;
  agents: string[];
  canManage: boolean;
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const initialPurpose =
    (SLACK_PURPOSES as readonly string[]).includes(ws.purpose) && ws.purpose !== "general"
      ? ws.purpose
      : (ws.suggested_purpose ?? "general");
  const [purpose, setPurpose] = useState(initialPurpose);
  const [label, setLabel] = useState(ws.label || ws.team_name || "");
  const [agent, setAgent] = useState(ws.default_agent_slug ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await saveSlackWorkspaceMeta({
        team_id: ws.team_id,
        purpose,
        label,
        default_agent_slug: agent,
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(friendlyError(e, "Couldn't save. Try again."));
    } finally {
      setSaving(false);
    }
  }

  const agentOptions = [
    "",
    ...(ws.default_agent_slug && !agents.includes(ws.default_agent_slug) ? [ws.default_agent_slug] : []),
    ...agents,
  ];

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.row}
        onPress={canManage ? onToggle : undefined}
        disabled={!canManage}
        accessibilityRole={canManage ? "button" : undefined}
        accessibilityState={canManage ? { expanded: open } : undefined}
        accessibilityLabel={`${nameOf(ws)}${ws.is_primary ? ", primary" : ""}`}
      >
        {ws.team_icon_url ? (
          <Image source={{ uri: ws.team_icon_url }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarLetter]}>
            <Text style={styles.avatarText}>{nameOf(ws).charAt(0).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.rowText}>
          <View style={styles.nameLine}>
            <Text style={styles.name} numberOfLines={1}>
              {nameOf(ws)}
            </Text>
            {ws.is_primary ? <Text style={styles.primary}>Primary</Text> : null}
          </View>
          <Text style={styles.sub} numberOfLines={2}>
            {`purpose: ${ws.purpose}${ws.default_agent_slug ? ` · default: ${ws.default_agent_slug}` : ""}${
              ws.missing.length > 0 ? ` · ${ws.missing.length} scope(s) pending` : ""
            }`}
          </Text>
        </View>
        {canManage ? <Icon name="dots" size={18} color={colors.wire.text} /> : null}
      </Pressable>

      {open && canManage ? (
        <View style={styles.editor}>
          <Text style={styles.fieldLabel}>What is this Slack for?</Text>
          <Chips options={SLACK_PURPOSES as readonly string[]} value={purpose} onChange={setPurpose} />

          <Text style={styles.fieldLabel}>Label</Text>
          <FocusRing radius={10}>
            {(focus) => (
              <TextInput
                keyboardAppearance={keyboardAppearance}
                style={styles.input}
                value={label}
                onChangeText={setLabel}
                maxLength={80}
                placeholder="Support Slack"
                placeholderTextColor={colors.muted}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                onFocus={focus.onFocus}
                onBlur={focus.onBlur}
              />
            )}
          </FocusRing>

          <Text style={styles.fieldLabel}>Default agent</Text>
          <Chips
            options={agentOptions}
            value={agent}
            onChange={setAgent}
            labelOf={(v) => (v === "" ? "(operator / none)" : v)}
          />

          <View style={styles.saveRow}>
            <Pressable
              style={({ pressed }) => [styles.save, (pressed || saving) && styles.dim]}
              onPress={() => void save()}
              disabled={saving}
              accessibilityRole="button"
            >
              <Text style={styles.saveText}>{saving ? "Saving…" : "Save"}</Text>
            </Pressable>
            {saved && !error ? <Text style={styles.saved}>Saved ✓</Text> : null}
          </View>
          <ErrorLine message={error} />
        </View>
      ) : null}
    </View>
  );
}

function Chips({
  options,
  value,
  onChange,
  labelOf = (v) => v,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  labelOf?: (v: string) => string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={o || "none"}
            style={[styles.chip, on && styles.chipOn]}
            onPress={() => onChange(o)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{labelOf(o)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headText: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.text },
  list: { gap: space.sm },
  card: {
    borderWidth: 1,
    borderColor: colors.wire.lineSoft,
    borderRadius: 14,
    backgroundColor: colors.panel,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    minHeight: 60,
  },
  avatar: { width: 37, height: 37, borderRadius: 9 },
  avatarLetter: {
    backgroundColor: "#4a154b",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: font.family.bold,
    fontSize: 15,
    color: colors.onAccent,
  },
  rowText: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: {
    flexShrink: 1,
    fontFamily: font.family.semi,
    fontSize: 15,
    color: colors.wire.text,
  },
  primary: {
    fontFamily: font.family.semi,
    fontSize: 11,
    color: colors.status.greenStrong,
    backgroundColor: colors.status.greenTint,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
    overflow: "hidden",
  },
  sub: {
    marginTop: 2,
    fontFamily: font.family.regular,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.textSecondary,
  },
  editor: { borderTopWidth: 1, borderTopColor: colors.wire.lineSoft, padding: 12, gap: 6 },
  fieldLabel: {
    marginTop: 6,
    fontFamily: font.family.medium,
    fontSize: 14,
    color: colors.textSecondary,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipOn: { backgroundColor: colors.wire.ink, borderColor: colors.wire.ink },
  chipText: {
    fontFamily: font.family.medium,
    fontSize: 13,
    lineHeight: 17,
    includeFontPadding: false,
    textAlignVertical: "center",
    color: colors.wire.text,
  },
  chipTextOn: { color: colors.onInk },
  input: {
    minHeight: 42,
    paddingHorizontal: 12,
    fontFamily: font.family.medium,
    fontSize: 15,
    color: colors.wire.text,
  },
  saveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
  },
  save: {
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: 999,
    backgroundColor: colors.wire.ink,
    justifyContent: "center",
  },
  saveText: { fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
  saved: { fontFamily: font.family.medium, fontSize: 13, color: colors.status.greenStrong },
  add: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 999,
  },
  addText: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.ink },
  hint: {
    fontFamily: font.family.regular,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSecondary,
    textAlign: "center",
  },
  dim: { opacity: 0.6 },
});
