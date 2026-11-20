export function NotConfigured() {
  return (
    <div data-zavi="not-configured" className="mx-auto max-w-md rounded border border-border bg-muted p-6 text-sm">
      <p className="font-medium">This site is not configured yet.</p>
      <p className="mt-2 text-muted-foreground">
        Its database connection is still being set up. Refresh in a minute.
      </p>
    </div>
  );
}
