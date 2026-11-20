import type { ReactNode } from "react";
import { Link, Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Admin from "./pages/Admin";
import Account from "./pages/Account";
import Confirm from "./pages/Confirm";
import { ScrollManager, SiteFooter, SiteHeader } from "./components/sections";
import { Container } from "./components/ui/layout";
import { buttonVariants } from "./components/ui/button";
import { SITE } from "./site";

function Page({ children }: { children: ReactNode }) {
  return <Container className="py-12 md:py-16">{children}</Container>;
}

export default function App() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <ScrollManager />
      <SiteHeader name={SITE.name} logo={SITE.logo} links={SITE.nav} cta={SITE.cta} />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Page><Login /></Page>} />
          <Route path="/admin" element={<Page><Admin /></Page>} />
          <Route path="/account" element={<Page><Account /></Page>} />
          <Route path="/auth/confirm" element={<Page><Confirm /></Page>} />
          <Route path="/auth/sign-in" element={<Page><Login /></Page>} />
          <Route
            path="*"
            element={
              <Page>
                <div data-zavi="not-found" className="mx-auto max-w-md py-16 text-center">
                  <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">404</p>
                  <h1 className="mt-3 text-display-md">Page not found.</h1>
                  <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-8" })}>
                    Back to home
                  </Link>
                </div>
              </Page>
            }
          />
        </Routes>
      </main>
      <SiteFooter name={SITE.name} links={SITE.nav} />
    </div>
  );
}
