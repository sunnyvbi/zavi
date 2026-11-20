import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "../Icon";
import { UnderlinedText } from "../UnderlinedText";
import { ErrorLine } from "../reply/ui";
import { friendlyError } from "../ErrorCard";
import { ApiFetchError } from "../../lib/api";
import {
  fetchRepoBranches,
  openConnectFlow,
  setDefaultRepo,
  setRepoBranch,
  setSelectedRepos,
} from "../../features/connectors/manage";
import { branchSaveErrorText } from "../../features/connectors/githubRepos";
import { shortDate, type ConnectorRow } from "../../features/connectors/health";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function GithubManage({
  row,
  canManage,
  managed = false,
  onChanged,
}: {
  row: ConnectorRow;
  canManage: boolean;
  managed?: boolean;
  onChanged: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const names = row.repo_full_names ?? [];
  const priv = row.repo_private ?? null;
  const [limitOpen, setLimitOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState<string | null>(null);
  const [busyRepo, setBusyRepo] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountLabel = (row.account_type ?? "").toLowerCase() === "organization" ? "organization" : "personal account";
  const installed = shortDate(row.connected_at ?? undefined);

  async function makeDefault(name: string) {
    setBusyRepo(name);
    setError(null);
    try {
      await setDefaultRepo(name);
      onChanged();
    } catch (e) {
      setError(`Failed to set default: ${friendlyError(e, "try again.")}`);
    } finally {
      setBusyRepo(null);
    }
  }

  async function installAnother() {
    setInstalling(true);
    setError(null);
    try {
      await openConnectFlow("github");
      onChanged();
    } catch (e) {
      setError(friendlyError(e, "Couldn't open GitHub. Try again."));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.meta}>
        {`${names.length} ${names.length === 1 ? "repository" : "repositories"}${installed ? ` · installed ${installed}` : ""}`}
      </Text>

      {managed ? (
        <Text style={styles.meta}>
          {`Zavi keeps your app's code in a private repo it manages${names[0] ? ` (${names[0]})` : ""}. To get your own copy, connect a GitHub account you own below, then use Export to my GitHub from the GitHub button on the Build screen.`}
        </Text>
      ) : null}

      {canManage && !managed && names.length > 0 ? (
        <Pressable
          style={({ pressed }) => [styles.tertiary, pressed && styles.dim]}
          onPress={() => setLimitOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: limitOpen }}
        >
          <Text style={styles.tertiaryText}>Limit which repos Zavi can reach</Text>
        </Pressable>
      ) : null}

      {limitOpen && canManage && !managed ? <RepoScope row={row} onClose={() => setLimitOpen(false)} onSaved={onChanged} /> : null}

      {managed ? null : names.length > 0 ? (
        <View style={styles.card}>
          <View style={styles.account}>
            {row.account_login ? (
              <Image
                source={{
                  uri: `https://github.com/${row.account_login}.png?size=64`,
                }}
                style={styles.avatar}
              />
            ) : null}
            <Text style={styles.accountName} numberOfLines={1}>
              {row.account_login ?? "—"}
            </Text>
            <Text style={styles.accountType}>{`· ${accountLabel}`}</Text>
          </View>
          {names.map((full, i) => {
            const slash = full.indexOf("/");
            const owner = slash >= 0 ? full.slice(0, slash + 1) : "";
            const repo = slash >= 0 ? full.slice(slash + 1) : full;
            const isPrimary = row.default_repo_full_name === full;
            const isPrivate = priv && i < priv.length ? priv[i] : undefined;
            const branch = row.repo_default_branches?.[full];
            const branchLabel = branch ? `Base: ${branch}` : "Repo default";
            return (
              <View key={full} style={styles.repo}>
                <View style={styles.repoRow}>
                  <Icon name="library" size={18} color={isPrimary ? colors.status.greenStrong : colors.textSecondary} />
                  <View style={styles.repoName}>
                    <Pressable
                      onPress={() => void Linking.openURL(`https://github.com/${full}`)}
                      accessibilityRole="link"
                      accessibilityLabel={`${full} on GitHub`}
                    >
                      <Text numberOfLines={1}>
                        <Text style={styles.owner}>{owner}</Text>
                        <Text style={styles.repoText}>{repo}</Text>
                      </Text>
                    </Pressable>
                    <View style={styles.repoMetaRow}>
                      {isPrivate === undefined ? null : (
                        <Text style={styles.repoMeta}>{isPrivate ? "Private ·" : "Public ·"}</Text>
                      )}
                      {canManage ? (
                        <Pressable
                          style={({ pressed }) => [styles.branchToggle, pressed && styles.dim]}
                          onPress={() => setBranchOpen((v) => (v === full ? null : full))}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Base branch for ${full}`}
                          accessibilityState={{ expanded: branchOpen === full }}
                        >
                          <UnderlinedText style={styles.branchLink}>{branchLabel}</UnderlinedText>
                        </Pressable>
                      ) : (
                        <Text style={styles.repoMeta}>{branchLabel}</Text>
                      )}
                    </View>
                  </View>
                  {isPrimary ? (
                    <Text style={styles.primary}>Primary</Text>
                  ) : canManage ? (
                    <Pressable
                      style={({ pressed }) => [styles.setDefault, (pressed || busyRepo === full) && styles.dim]}
                      onPress={() => void makeDefault(full)}
                      disabled={busyRepo !== null}
                      accessibilityRole="button"
                      accessibilityLabel={`Set ${full} as default repo`}
                    >
                      <Text style={styles.setDefaultText}>{busyRepo === full ? "Saving…" : "Set as default"}</Text>
                    </Pressable>
                  ) : null}
                </View>
                {branchOpen === full && canManage ? (
                  <BranchPicker
                    fullName={full}
                    branch={branch}
                    onClose={() => setBranchOpen(null)}
                    onSaved={onChanged}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={styles.meta}>No repositories yet. Install the Zavi GitHub App on an account with repos.</Text>
      )}

      {canManage ? (
        <View style={styles.install}>
          <Text style={styles.installText}>
            {managed ? (
              <Text style={styles.installLead}>Connect a GitHub account you own to export your app&apos;s code. </Text>
            ) : (
              <Text style={styles.installLead}>
                Only repos owned by the account where the Zavi GitHub App is installed appear here.{" "}
              </Text>
            )}
            To add repos in another organization (e.g. where you&apos;re a contributor), install Zavi on that
            organization too.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.tertiary, (pressed || installing) && styles.dim]}
            onPress={() => void installAnother()}
            disabled={installing}
            accessibilityRole="button"
          >
            {installing ? <ActivityIndicator size="small" color={colors.wire.ink} /> : null}
            <Text style={styles.tertiaryText}>Install on another organization</Text>
          </Pressable>
        </View>
      ) : null}
      <ErrorLine message={error} />
    </View>
  );
}

function RepoScope({ row, onClose, onSaved }: { row: ConnectorRow; onClose: () => void; onSaved: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const names = row.repo_full_names ?? [];
  const ids = row.repo_ids ?? [];
  const pairs = useMemo(
    () =>
      names
        .map((name, i) => ({ name, id: ids[i] }))
        .filter((p): p is { name: string; id: number } => typeof p.id === "number"),
    [names, ids],
  );
  const isScoped = Array.isArray(row.selected_repo_ids);
  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(isScoped ? (row.selected_repo_ids as number[]) : pairs.map((p) => p.id)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pairs.length === 0) {
    return (
      <Text style={styles.scopeNote}>
        Repo scoping isn&apos;t available for this connection yet. Reconnect GitHub to enable per-repo access control.
      </Text>
    );
  }

  const allChecked = pairs.every((p) => checked.has(p.id));
  const defaultPair = row.default_repo_full_name ? pairs.find((p) => p.name === row.default_repo_full_name) : undefined;
  const defaultWillBeCleared = defaultPair !== undefined && !checked.has(defaultPair.id);
  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function save(ids: number[] | null) {
    setSaving(true);
    setError(null);
    try {
      await setSelectedRepos(ids);
      onSaved();
      onClose();
    } catch (e) {
      setError(`Failed to save repo selection: ${friendlyError(e, "try again.")}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.scope}>
      <Text style={styles.scopeTitle}>Select the repositories Zavi&apos;s agents may reach</Text>
      <Text style={styles.scopeNote}>
        Only checked repositories are reachable by your agents. Access is enforced on the server for every repo read.
      </Text>
      <Pressable
        style={styles.checkRow}
        onPress={() => setChecked(allChecked ? new Set() : new Set(pairs.map((p) => p.id)))}
        accessibilityRole="button"
      >
        <Text style={styles.selectAll}>{allChecked ? "Deselect all" : "Select all"}</Text>
      </Pressable>
      {pairs.map((p) => {
        const on = checked.has(p.id);
        return (
          <Pressable
            key={p.id}
            style={styles.checkRow}
            onPress={() => toggle(p.id)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
          >
            <View style={[styles.box, on && styles.boxOn]}>
              {on ? <Icon name="check" size={13} color={colors.onInk} /> : null}
            </View>
            <Text style={styles.checkText} numberOfLines={1}>
              {p.name}
            </Text>
            {p.name === row.default_repo_full_name ? <Text style={styles.primary}>Primary</Text> : null}
          </Pressable>
        );
      })}
      {defaultWillBeCleared ? (
        <Text style={styles.warn}>
          {`⚠ ${row.default_repo_full_name} is your default repo. Unchecking it clears the default, and agents then have to guess which repo a request means. Set a new default after saving.`}
        </Text>
      ) : null}
      {checked.size === 0 ? (
        <Text style={styles.warn}>⚠ No repositories selected — agents won&apos;t be able to reach any repo.</Text>
      ) : null}
      <View style={styles.scopeActions}>
        <Pressable
          style={({ pressed }) => [styles.save, (pressed || saving) && styles.dim]}
          onPress={() => void save(Array.from(checked))}
          disabled={saving}
          accessibilityRole="button"
        >
          <Text style={styles.saveText}>{saving ? "Saving…" : "Save selection"}</Text>
        </Pressable>
        <Pressable style={styles.plain} onPress={onClose} disabled={saving} accessibilityRole="button">
          <Text style={styles.plainText}>Cancel</Text>
        </Pressable>
      </View>
      {isScoped ? (
        <Pressable style={styles.plain} onPress={() => void save(null)} disabled={saving} accessibilityRole="button">
          <Text style={styles.plainText}>Allow all repositories</Text>
        </Pressable>
      ) : null}
      <ErrorLine message={error} />
    </View>
  );
}

function BranchPicker({
  fullName,
  branch,
  onClose,
  onSaved,
}: {
  fullName: string;
  branch: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [current, setCurrent] = useState(branch);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRepoBranches(fullName)
      .then((b) => {
        setBranches(b.branches);
        if (b.current) setCurrent(b.current);
      })
      .catch(() => setError("Couldn't load branches"));
  }, [fullName]);

  const options =
    branches === null
      ? []
      : !current
        ? ["", ...branches]
        : branches.includes(current)
          ? branches
          : [current, ...branches];

  async function pick(name: string) {
    setSaving(name);
    setError(null);
    try {
      await setRepoBranch(fullName, name);
      onSaved();
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiFetchError
          ? branchSaveErrorText(e.code, e.status)
          : "Couldn't save. Check your connection and try again.",
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <View style={[styles.scope, styles.branchPanel]}>
      <Text style={styles.branchNote}>Branch the engineer opens PRs against</Text>
      {branches === null && error === null ? (
        <View style={styles.branchRow}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.branchNote}>Loading…</Text>
        </View>
      ) : null}
      {options.map((b) => {
        const on = b === (current ?? "");
        return (
          <Pressable
            key={b || "repo-default"}
            style={({ pressed }) => [styles.branchRow, pressed && styles.branchRowPressed]}
            onPress={() => void pick(b)}
            disabled={on || saving !== null}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
          >
            <Text style={styles.checkText} numberOfLines={1}>
              {b || "Repo default"}
            </Text>
            {saving === b ? (
              <ActivityIndicator size="small" color={colors.wire.ink} />
            ) : on ? (
              <Icon name="check" size={16} color={colors.wire.ink} />
            ) : null}
          </Pressable>
        );
      })}
      <ErrorLine message={error} />
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  meta: {
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  tertiary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 999,
    paddingHorizontal: 14,
  },
  tertiaryText: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.ink },
  card: {
    borderWidth: 1,
    borderColor: colors.wire.lineSoft,
    borderRadius: 16,
    backgroundColor: colors.panel,
    overflow: "hidden",
  },
  account: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.wire.head,
    borderBottomWidth: 1,
    borderBottomColor: colors.wire.lineSoft,
  },
  avatar: { width: 22, height: 22, borderRadius: 11 },
  accountName: {
    flexShrink: 1,
    fontFamily: font.family.semi,
    fontSize: 14,
    color: colors.wire.strong,
  },
  accountType: { fontFamily: font.family.regular, fontSize: 13, color: colors.textSecondary },
  repo: {
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.wire.lineSoft,
    marginBottom: -1,
  },
  repoRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  repoName: { flex: 1, minWidth: 0 },
  owner: { fontFamily: font.family.regular, fontSize: 14, color: colors.textSecondary },
  repoText: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.strong },
  repoMetaRow: { flexDirection: "row", alignItems: "baseline", gap: 4, marginTop: 2 },
  repoMeta: {
    flexShrink: 1,
    fontFamily: font.family.regular,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  branchToggle: { flexShrink: 1 },
  branchLink: { fontFamily: font.family.semi, fontSize: 12, color: colors.wire.ink },
  branchPanel: { marginLeft: 28 },
  branchNote: {
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  branchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 40,
    paddingHorizontal: 8,
    marginHorizontal: -8,
    borderRadius: 8,
  },
  branchRowPressed: { backgroundColor: colors.soft },
  primary: {
    fontFamily: font.family.semi,
    fontSize: 11,
    color: colors.status.greenStrong,
    backgroundColor: colors.status.greenTint,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: "hidden",
  },
  setDefault: {
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  setDefaultText: {
    fontFamily: font.family.medium,
    fontSize: 12,
    color: colors.wire.strong,
  },
  install: { gap: space.sm, marginTop: 4 },
  installText: {
    fontFamily: font.family.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  installLead: { color: colors.wire.strong },
  scope: {
    borderWidth: 1,
    borderColor: colors.wire.lineSoft,
    borderRadius: 16,
    padding: 12,
    gap: 6,
  },
  scopeTitle: { fontFamily: font.family.semi, fontSize: 14, color: colors.wire.strong },
  scopeNote: {
    fontFamily: font.family.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 40,
  },
  selectAll: {
    fontFamily: font.family.semi,
    fontSize: 13,
    color: colors.wire.ink,
    textDecorationLine: "underline",
  },
  box: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.wire.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: colors.wire.ink, borderColor: colors.wire.ink },
  checkText: {
    flex: 1,
    fontFamily: font.family.regular,
    fontSize: 14,
    color: colors.wire.strong,
  },
  warn: {
    fontFamily: font.family.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.status.amberText,
  },
  scopeActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 6,
  },
  save: {
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: colors.wire.ink,
    justifyContent: "center",
  },
  saveText: { fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
  plain: { minHeight: 48, justifyContent: "center" },
  plainText: { fontFamily: font.family.semi, fontSize: 14, color: colors.textSecondary },
  dim: { opacity: 0.6 },
});
