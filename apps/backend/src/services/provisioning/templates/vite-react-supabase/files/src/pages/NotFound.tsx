import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <section data-zavi="not-found" className="flex flex-col items-center gap-4 py-16 text-center">
      <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">404</p>
      <h1 className="text-3xl font-bold tracking-tight">Page not found</h1>
      <p className="max-w-md text-muted-foreground">The page you are looking for does not exist or has moved.</p>
      <Link to="/" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
        Back to home
      </Link>
    </section>
  );
}
