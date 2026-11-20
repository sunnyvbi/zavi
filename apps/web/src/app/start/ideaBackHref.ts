export function ideaBackHref(search: string) {
  const params = new URLSearchParams(search);
  params.delete("step");
  params.delete("resume");
  const query = params.toString();
  return query ? `/start?${query}` : "/start";
}
