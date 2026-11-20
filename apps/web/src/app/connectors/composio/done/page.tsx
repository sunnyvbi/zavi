import { ComposioDone } from "./ComposioDone";

export default async function ComposioDonePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ComposioDone searchParams={await searchParams} />;
}
