import { Clipboard, Pressable, StyleSheet, Text, View } from "react-native";
import { ListGroup, SectionLabel } from "./SettingsUI";
import { addressLabel, useInboxAddresses } from "../../features/settings/inboxAddresses";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export function AgentInboxAddresses({ onCopied }: { onCopied: (message: string) => void }) {
  const styles = useStyles(makeStyles);
  const q = useInboxAddresses();
  if (!q.data) return null;
  const list = q.data;

  return (
    <>
      <SectionLabel>Agent email addresses</SectionLabel>
      <Text style={styles.intro}>Email any agent directly. Messages route into its inbox and the agent triages them like a teammate.</Text>
      {list.length === 0 ? (
        <Text style={styles.empty}>Email isn't set up for this workspace yet. Contact your account team to enable per-agent inboxes.</Text>
      ) : (
        <ListGroup>
          {list.map((a, i) => (
            <View key={a.agent_slug} style={[styles.row, i > 0 && styles.divider]}>
              <View style={styles.text}>
                <Text style={styles.name} numberOfLines={1}>{addressLabel(a)}</Text>
                <Text style={styles.address} numberOfLines={1} selectable>{a.address}</Text>
              </View>
              <Pressable
                style={styles.copy}
                hitSlop={8}
                onPress={() => {
                  Clipboard.setString(a.address);
                  onCopied("Email address copied.");
                }}
                accessibilityRole="button"
                accessibilityLabel={`Copy ${addressLabel(a)} email address`}
              >
                <Text style={styles.copyText}>Copy</Text>
              </Pressable>
            </View>
          ))}
        </ListGroup>
      )}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    intro: { marginBottom: space.sm, fontFamily: font.family.regular, fontSize: font.size.md, lineHeight: 18, color: colors.muted },
    empty: { fontFamily: font.family.regular, fontSize: font.size.md, lineHeight: 18, color: colors.muted },
    row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 60, paddingHorizontal: space.md, paddingVertical: 10, backgroundColor: colors.panel },
    divider: { borderTopWidth: 1, borderTopColor: colors.line },
    text: { flex: 1, minWidth: 0, gap: 2 },
    name: { fontFamily: font.family.medium, fontSize: font.size.base, lineHeight: 18, color: colors.ink },
    address: { fontFamily: font.family.regular, fontSize: font.size.md, lineHeight: 17, color: colors.textSecondary },
    copy: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.line },
    copyText: { fontFamily: font.family.medium, fontSize: font.size.md, color: colors.ink },
  });
