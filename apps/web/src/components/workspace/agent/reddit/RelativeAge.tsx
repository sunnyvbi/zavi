import { useRelativeAge } from "./useRelativeAge";

export function RelativeAge({ iso }: { iso: string | null }) {
  const age = useRelativeAge(iso);
  return <>{age ?? "-"}</>;
}
