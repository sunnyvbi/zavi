import { Link } from "react-router-dom";

export default function Home() {
  return (
    <section data-zavi="home" className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Welcome</h1>
      <p className="max-w-prose text-muted-foreground">This site is being built. Check back soon.</p>
      <Link
        to="/login"
        className="inline-block rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Sign in
      </Link>
    </section>
  );
}
