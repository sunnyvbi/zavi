import { forwardRef, useCallback } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetModal,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "./AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalCard } from "./ApprovalCard";
import { usePendingApprovals } from "../features/approvals/hooks";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

export const ApprovalsSheet = forwardRef<BottomSheetModal>(function ApprovalsSheet(_props, ref) {
  const styles = useStyles(makeStyles);
  const { data } = usePendingApprovals();
  const decisions = data ?? [];
  const insets = useSafeAreaInsets();

  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} />
    ),
    [],
  );

  const onSheetChange = useBackClosesSheet();
  return (
    <BottomSheetModal
      ref={ref}
      onChange={onSheetChange}
      snapPoints={["55%", "85%"]}
      enableDynamicSizing={false}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
    >
      <BottomSheetFlatList
        data={decisions}
        keyExtractor={(d) => d.id}
        contentContainerStyle={[styles.content, { paddingBottom: space.xl + insets.bottom }]}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListHeaderComponent={<Text style={styles.title}>Approvals</Text>}
        ListEmptyComponent={
          <Text style={styles.empty}>Decisions that need you will queue here.</Text>
        }
        renderItem={({ item }) => <ApprovalCard decision={item} variant="list" />}
      />
    </BottomSheetModal>
  );
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBg: { backgroundColor: colors.surfaceRaised },
  content: { paddingHorizontal: space.md },
  title: { fontSize: font.size.lg, fontWeight: "800", color: colors.ink, marginBottom: space.md },
  sep: { height: space.md },
  empty: { fontSize: font.size.base, color: colors.muted },
});
