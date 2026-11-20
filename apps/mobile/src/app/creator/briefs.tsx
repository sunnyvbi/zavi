import { StyleSheet, Text } from "react-native";
import {
  Card,
  CreatorScreen,
  Empty,
  ErrorNote,
  KeyValue,
  Loading,
  Note,
} from "../../components/creator/CreatorChrome";
import { useCreatorBriefs } from "../../features/creator/hooks";
import { CreatorApiError, day, type CreatorBriefCard } from "../../features/creator/api";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

function budgetText(usd: number): string {
  return `$${String(Math.round(usd)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function BriefCard({ brief }: { brief: CreatorBriefCard }) {
  const styles = useStyles(makeStyles);
  return (
    <Card>
      <Text style={styles.title}>{brief.title ?? "A brief"}</Text>
      {brief.lane === "ugc_video" ? (
        <Text style={styles.lane}>A video the business runs as its ad</Text>
      ) : null}
      {brief.budget_usd != null ? (
        <KeyValue label="Budget" value={budgetText(brief.budget_usd)} strong />
      ) : null}
      {brief.delivery_days != null ? (
        <KeyValue label="Delivery" value={`${brief.delivery_days} days`} />
      ) : null}
      {brief.answer_by ? (
        <KeyValue label="Everyone hears back by" value={day(brief.answer_by)} />
      ) : null}
      {brief.applicant_cap != null ? (
        <KeyValue label="Closes at" value={`${brief.applicant_cap} applications`} />
      ) : null}
      <Text style={styles.hint}>
        You name your own price when you apply. The budget above is what the business had in mind.
      </Text>
    </Card>
  );
}

export default function CreatorBriefsScreen() {
  const styles = useStyles(makeStyles);
  const { data, isPending, error } = useCreatorBriefs();

  return (
    <CreatorScreen title="Briefs">
      {error ? (
        <ErrorNote
          message={error instanceof CreatorApiError ? error.message : "The board did not load."}
        />
      ) : isPending || !data ? (
        <Loading what="open briefs" />
      ) : (
        <>
          <Note>To apply with your own price, open Briefs on zaviagent.com/creator.</Note>
          {data.briefs.length === 0 ? (
            <Empty>
              No open briefs in your lanes right now. Businesses can also book you straight from
              your page.
            </Empty>
          ) : (
            <>
              {data.briefs.map((b) => (
                <BriefCard key={b.id} brief={b} />
              ))}
              <Text style={styles.hint}>{data.order}. Zavi does not sort briefs by fit.</Text>
            </>
          )}
        </>
      )}
    </CreatorScreen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  title: { fontSize: font.size.lg, fontWeight: "700", color: colors.ink },
  lane: { fontSize: font.size.md, color: colors.muted, marginBottom: space.xs },
  hint: { fontSize: font.size.sm, lineHeight: 17, color: colors.muted },
});
