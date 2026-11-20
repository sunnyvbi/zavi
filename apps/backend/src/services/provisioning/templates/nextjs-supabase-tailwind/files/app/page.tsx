import { hasSupabaseConfig } from "@/lib/supabase";

export default function Home() {
  const dbReady = hasSupabaseConfig();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
        Your company app is live.
      </h1>
      <p className="max-w-xl text-lg text-gray-600">
        This is a working Next.js starter. Edit{" "}
        <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm">
          app/page.tsx
        </code>{" "}
        and your changes ship on the next deploy.
      </p>
      <span
        className={`rounded-full px-4 py-1.5 text-sm font-medium ${
          dbReady
            ? "bg-green-100 text-green-800"
            : "bg-amber-100 text-amber-800"
        }`}
      >
        {dbReady ? "Database connected" : "Database not configured yet"}
      </span>
    </main>
  );
}
