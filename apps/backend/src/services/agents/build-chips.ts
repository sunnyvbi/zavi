
export type BuildChip = {
  key: string;
  label: string;
  prompt: string;
};

type ChipDef = BuildChip & {
  doneWhen: string[];
};

type Archetype =
  | "marketplace"
  | "shop"
  | "dashboard"
  | "landing"
  | "blog"
  | "generic";

const CHIPS_BY_ARCHETYPE: Record<Archetype, ChipDef[]> = {
  marketplace: [
    { key: "mkt-browse", label: "Build Browse Page", prompt: "Add a browse page that lists all items with a grid and basic filters.", doneWhen: ["browse", "listing grid", "catalog"] },
    { key: "mkt-detail", label: "Create Listing Detail", prompt: "Add a listing detail page showing full info for a single item.", doneWhen: ["detail page", "listing detail", "item page"] },
    { key: "mkt-auth", label: "Add Auth Flows", prompt: "Add sign up and log in so users can create accounts.", doneWhen: ["auth", "sign up", "signup", "log in", "login"] },
    { key: "mkt-seller", label: "Set Up Seller Dashboard", prompt: "Add a seller dashboard where sellers manage their listings.", doneWhen: ["seller dashboard", "seller", "vendor"] },
    { key: "mkt-search", label: "Add Search & Filters", prompt: "Add search and category filters to the browse page.", doneWhen: ["search", "filter"] },
  ],
  shop: [
    { key: "shop-grid", label: "Build Product Grid", prompt: "Add a product grid on the homepage showing all products.", doneWhen: ["product grid", "products page", "catalog"] },
    { key: "shop-cart", label: "Add Cart", prompt: "Add a shopping cart users can add products to.", doneWhen: ["cart", "basket"] },
    { key: "shop-checkout", label: "Add Checkout", prompt: "Add a checkout page to complete a purchase.", doneWhen: ["checkout", "payment", "stripe"] },
    { key: "shop-auth", label: "Add Auth Flows", prompt: "Add sign up and log in for shoppers.", doneWhen: ["auth", "sign up", "signup", "log in", "login"] },
  ],
  dashboard: [
    { key: "dash-auth", label: "Add Auth Flows", prompt: "Add sign up and log in to gate the dashboard.", doneWhen: ["auth", "sign up", "signup", "log in", "login"] },
    { key: "dash-table", label: "Add a Data Table", prompt: "Add a sortable, paginated data table to the main view.", doneWhen: ["table", "data grid"] },
    { key: "dash-settings", label: "Build Settings Page", prompt: "Add a settings page where users update their profile and preferences.", doneWhen: ["settings", "profile page"] },
    { key: "dash-billing", label: "Add Billing", prompt: "Add a billing page showing the current plan and usage.", doneWhen: ["billing", "plan", "subscription"] },
  ],
  landing: [
    { key: "land-signup", label: "Add Email Signup", prompt: "Add an email signup form that captures the waitlist.", doneWhen: ["email signup", "waitlist", "sign up form", "newsletter"] },
    { key: "land-pricing", label: "Add Pricing Section", prompt: "Add a pricing section with plan tiers.", doneWhen: ["pricing", "plans", "tiers"] },
    { key: "land-faq", label: "Add an FAQ", prompt: "Add a frequently-asked-questions section.", doneWhen: ["faq", "questions"] },
    { key: "land-testimonials", label: "Add Testimonials", prompt: "Add a testimonials section with social proof.", doneWhen: ["testimonial", "reviews", "social proof"] },
  ],
  blog: [
    { key: "blog-list", label: "Add Post List", prompt: "Add a blog index page listing all posts.", doneWhen: ["post list", "blog index", "posts page"] },
    { key: "blog-detail", label: "Add Post Detail", prompt: "Add a post detail page rendering a single article.", doneWhen: ["post detail", "article page", "post page"] },
    { key: "blog-author", label: "Add Author Pages", prompt: "Add author profile pages listing each author's posts.", doneWhen: ["author"] },
    { key: "blog-auth", label: "Add Auth Flows", prompt: "Add sign up and log in for authors.", doneWhen: ["auth", "sign up", "signup", "log in", "login"] },
  ],
  generic: [
    { key: "gen-auth", label: "Add Auth Flows", prompt: "Add sign up and log in so users can create accounts.", doneWhen: ["auth", "sign up", "signup", "log in", "login"] },
    { key: "gen-contact", label: "Add a Contact Form", prompt: "Add a contact form that emails submissions.", doneWhen: ["contact form", "contact page"] },
    { key: "gen-about", label: "Add an About Page", prompt: "Add an about page describing the product.", doneWhen: ["about page", "about"] },
    { key: "gen-home", label: "Improve the Homepage", prompt: "Polish the homepage hero and layout.", doneWhen: ["homepage", "hero", "landing page"] },
  ],
};

function classifyArchetype(idea: string): Archetype {
  const t = idea.toLowerCase();
  const has = (...words: string[]) => words.some((w) => t.includes(w));
  if (
    has("landing", "marketing site", "coming soon") &&
    !has("marketplace", "p2p", "peer-to-peer", "two-sided", "shop", "store", "ecommerce", "e-commerce", "dashboard", "admin panel", "internal tool")
  ) return "landing";
  if (has("marketplace", "p2p", "peer-to-peer", "listing", "rent", "sellers and buyers", "two-sided")) return "marketplace";
  if (has("shop", "store", "ecommerce", "e-commerce", "products", "checkout")) return "shop";
  if (has("dashboard", "admin panel", "saas", "analytics", "internal tool")) return "dashboard";
  if (has("blog", "articles", "posts", "publication", "newsletter")) return "blog";
  if (has("landing", "waitlist", "coming soon", "signup page", "marketing site")) return "landing";
  return "generic";
}

const MAX_CHIPS = 5;

export function computeBuildChips(args: {
  objective: string | null | undefined;
  priorRefines: string[];
}): BuildChip[] {
  const objective = (args.objective ?? "").trim();
  if (!objective) return [];
  const archetype = classifyArchetype(objective);
  const refineBlob = args.priorRefines.join(" • ").toLowerCase();
  const objectiveLower = objective.toLowerCase();

  const chips = CHIPS_BY_ARCHETYPE[archetype].filter((c) => {
    return !c.doneWhen.some(
      (kw) => refineBlob.includes(kw) || objectiveLower.includes(kw),
    );
  });

  return chips.slice(0, MAX_CHIPS).map(({ key, label, prompt }) => ({ key, label, prompt }));
}

type OwnerArchetype = Archetype | "booking";

const OWNER_STEPS_BY_ARCHETYPE: Record<OwnerArchetype, ChipDef[]> = {
  booking: [
    { key: "own-hours", label: "Add Opening Hours", prompt: "Add my opening hours to the site so customers only book times I'm open.", doneWhen: ["opening hours", "business hours", "hours"] },
    { key: "own-test-booking", label: "Test a Booking", prompt: "Walk me through making a test booking on my site so I can see what customers see.", doneWhen: ["test booking", "test a booking"] },
    { key: "own-services", label: "Update Services & Prices", prompt: "Update the services and prices on my site to match what I offer.", doneWhen: ["services and prices", "price list"] },
    { key: "own-share", label: "Share Your Link", prompt: "How do I share my site's link with customers?", doneWhen: ["share"] },
  ],
  marketplace: [
    { key: "own-listings", label: "Add First Listings", prompt: "Help me add the first real listings to my site.", doneWhen: ["first listings", "real listings"] },
    { key: "own-test-signup", label: "Test Sign Up", prompt: "Walk me through signing up on my site as a new user.", doneWhen: ["test sign up", "test signup"] },
    { key: "own-share", label: "Share Your Link", prompt: "How do I share my site's link with customers?", doneWhen: ["share"] },
  ],
  shop: [
    { key: "own-products", label: "Add Your Products", prompt: "Help me add my real products with photos and prices.", doneWhen: ["real products", "my products"] },
    { key: "own-test-order", label: "Test an Order", prompt: "Walk me through placing a test order on my site.", doneWhen: ["test order", "test purchase"] },
    { key: "own-share", label: "Share Your Link", prompt: "How do I share my site's link with customers?", doneWhen: ["share"] },
  ],
  dashboard: [
    { key: "own-test-signin", label: "Test Sign In", prompt: "Walk me through signing in to my app as a new user.", doneWhen: ["test sign in", "test login"] },
    { key: "own-real-data", label: "Add Real Data", prompt: "Help me replace the sample data with my real data.", doneWhen: ["real data"] },
    { key: "own-share", label: "Share Your Link", prompt: "How do I share my app's link with my team?", doneWhen: ["share"] },
  ],
  landing: [
    { key: "own-test-form", label: "Test the Signup Form", prompt: "Walk me through submitting the signup form on my site to check it works.", doneWhen: ["test the signup", "test signup form"] },
    { key: "own-logo", label: "Add Your Logo", prompt: "Add my logo to the site.", doneWhen: ["logo"] },
    { key: "own-share", label: "Share Your Link", prompt: "How do I share my site's link with customers?", doneWhen: ["share"] },
  ],
  blog: [
    { key: "own-first-post", label: "Write Your First Post", prompt: "Help me write and add my first real post.", doneWhen: ["first post"] },
    { key: "own-share", label: "Share Your Link", prompt: "How do I share my blog's link with readers?", doneWhen: ["share"] },
  ],
  generic: [
    { key: "own-test-site", label: "Test Your Site", prompt: "Walk me through checking each page of my site works.", doneWhen: ["test your site", "test the site"] },
    { key: "own-contact", label: "Update Contact Details", prompt: "Update the contact details on my site to my real phone, email and address.", doneWhen: ["contact details"] },
    { key: "own-share", label: "Share Your Link", prompt: "How do I share my site's link with customers?", doneWhen: ["share"] },
  ],
};

function classifyOwnerArchetype(idea: string): OwnerArchetype {
  const t = idea.toLowerCase();
  if (["booking", "appointment", "reservation", "schedule a", "salon", "grooming", "clinic"].some((w) => t.includes(w))) {
    return "booking";
  }
  return classifyArchetype(idea);
}

export function computeOwnerNextSteps(args: {
  objective: string | null | undefined;
  priorRefines: string[];
}): BuildChip[] {
  const objective = (args.objective ?? "").trim();
  if (!objective) return [];
  const refineBlob = args.priorRefines.join(" • ").toLowerCase();
  return OWNER_STEPS_BY_ARCHETYPE[classifyOwnerArchetype(objective)]
    .filter((c) => !c.doneWhen.some((kw) => refineBlob.includes(kw)))
    .slice(0, MAX_CHIPS)
    .map(({ key, label, prompt }) => ({ key, label, prompt }));
}
