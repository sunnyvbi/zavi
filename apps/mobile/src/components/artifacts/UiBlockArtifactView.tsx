import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { UI_BLOCK_MIME } from "@zavi/shared";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { UiBlockCard } from "../reply/UiBlockCard";
import type { Artifact } from "../../features/artifacts/types";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function isUiBlockArtifact(a: Pick<Artifact, "mime" | "type" | "filename">): boolean {
  return a.mime === UI_BLOCK_MIME || (a.type === "dashboard" && /\.json$/i.test(a.filename));
}

const asRunArtifact = (a: Artifact) => ({ id: a.id, run_id: a.run_id, filename: a.filename, mime: a.mime, bytes: a.bytes });

export function UiBlockArtifactView({ artifact, fallback }: { artifact: Artifact; fallback: ReactNode }) {
  return <UiBlockCard artifact={asRunArtifact(artifact)} fallback={fallback} />;
}

export function UiBlockViewer({ artifact, onClose }: { artifact: Artifact | null; onClose: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!artifact} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.safe, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.bar}>
          <Text style={styles.title} numberOfLines={1}>
            {artifact?.title ?? ""}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {artifact ? (
            <UiBlockCard
              artifact={asRunArtifact(artifact)}
              fallback={<Text style={styles.empty}>This dashboard can't be shown here.</Text>}
            />
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    bar: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
    title: { flex: 1, minWidth: 0, includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.lg, color: colors.ink },
    close: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.soft, alignItems: "center", justifyContent: "center" },
    pressed: { opacity: 0.7 },
    content: { padding: space.lg },
    empty: { fontFamily: font.family.regular, fontSize: font.size.base, color: colors.muted },
  });
