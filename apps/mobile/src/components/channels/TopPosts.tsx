import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Icon } from "../Icon";
import { TextLink } from "../growth/StoryKit";
import { TOP_POSTS_SHOWN, type TopPostsTable } from "../../features/channels/topPosts";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const open = (url: string) => void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => {}));

export function TopPostsCard({ table }: { table: TopPostsTable }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, TOP_POSTS_SHOWN);
  const cell = (i: number) => [styles.cell, { width: table.columns[i].width }, i > 0 && styles.cellDivider];
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Icon name="trending" size={16} color={colors.ink} />
        <Text style={styles.title}>{table.title}</Text>
      </View>
      {table.rows.length === 0 ? (
        <Text style={styles.empty}>{table.empty}</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleed} contentContainerStyle={styles.bleedInner}>
          <View style={styles.grid}>
            <View style={[styles.gridRow, styles.gridHead]}>
              {table.columns.map((c, i) => (
                <View key={c.label} style={cell(i)}>
                  <Text style={[styles.headText, c.right && styles.right]}>{c.label}</Text>
                </View>
              ))}
            </View>
            {rows.map((r) => (
              <View key={r.id} style={[styles.gridRow, styles.rowDivider]}>
                {r.cells.map((c, i) => (
                  <View key={i} style={cell(i)}>
                    {c.href ? (
                      <Pressable onPress={() => open(c.href as string)} accessibilityRole="link" hitSlop={4}>
                        <Text style={styles.link} numberOfLines={3}>
                          {c.text}
                        </Text>
                      </Pressable>
                    ) : (
                      <Text style={[styles.text, c.strong && styles.strong, c.dim && styles.dim, table.columns[i].right && styles.right]} numberOfLines={i === 0 ? 3 : undefined}>
                        {c.text}
                      </Text>
                    )}
                    {c.sub ? <Text style={[styles.sub, table.columns[i].right && styles.right]}>{c.sub}</Text> : null}
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      {table.rows.length > TOP_POSTS_SHOWN ? (
        <TextLink label={all ? `Show top ${TOP_POSTS_SHOWN}` : `Show all ${table.rows.length}`} expanded={all} onPress={() => setAll((v) => !v)} />
      ) : null}
      {table.caption ? <Text style={styles.sub}>{table.caption}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: space.md, padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.panel },
    head: { flexDirection: "row", alignItems: "center", gap: space.sm },
    title: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    empty: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted },
    bleed: { marginHorizontal: -space.lg },
    bleedInner: { paddingHorizontal: space.lg },
    grid: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden" },
    gridRow: { flexDirection: "row" },
    gridHead: { backgroundColor: colors.soft },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    cell: { paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
    cellDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
    headText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    right: { textAlign: "right" },
    text: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    strong: { fontFamily: font.family.semi },
    dim: { color: colors.muted },
    link: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
  });
