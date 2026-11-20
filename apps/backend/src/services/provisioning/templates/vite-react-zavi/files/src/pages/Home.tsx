import { Contact, Hero } from "../components/sections";

export default function Home() {
  return (
    <div data-zavi="home">
      <Hero
        variant="centered"
        eyebrow="Coming soon"
        title="Welcome"
        subtitle="This site is being built. Check back soon."
        actions={[{ label: "Get in touch", href: "#contact" }]}
      />
      <Contact tone="muted" />
    </div>
  );
}
