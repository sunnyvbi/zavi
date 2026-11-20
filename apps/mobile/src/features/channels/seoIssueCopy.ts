
export type IssueOwner = "founder" | "developer";

export type IssueCopy = {
  title: (pages: number) => string;
  why: string;
  how: string;
  owner: IssueOwner;
};

const pages = (n: number) => (n === 1 ? "1 page" : `${n} pages`);
const v = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const ISSUE_COPY: Record<string, IssueCopy> = {
  robots_disallow_all: {
    title: () => "robots.txt blocks every search engine from the whole site",
    why: "Nothing on the site can be crawled, so nothing can rank.",
    how: "Remove the 'Disallow: /' line under 'User-agent: *' in robots.txt.",
    owner: "developer",
  },
  noindex: {
    title: (n) => `${pages(n)} ${v(n, "tells", "tell")} search engines not to list ${v(n, "it", "them")}`,
    why: "A noindex tag keeps the page out of results, however good it is.",
    how: "Remove the noindex tag, or the 'hide from search' setting in your CMS, on pages you want found.",
    owner: "developer",
  },
  title_missing: {
    title: (n) => `${pages(n)} ${v(n, "has", "have")} no title`,
    why: "The title is the headline a searcher reads before they ever reach the site.",
    how: "Give each page a title under 60 characters that names what it is about.",
    owner: "founder",
  },
  title_duplicate: {
    title: (n) => `${pages(n)} ${v(n, "shares", "share")} a title with another page`,
    why: "Search engines cannot tell which page answers which query, which is the most common reason a real page never ranks.",
    how: "Give each page its own title, under 60 characters, that names what that page is about.",
    owner: "founder",
  },
  thin_server_html: {
    title: (n) => `${pages(n)} ${v(n, "shows", "show")} almost no text before JavaScript runs`,
    why: "Search engines and AI crawlers may see an empty page, so it cannot rank or be cited.",
    how: "Render the main content on the server, or add a static summary paragraph to the page.",
    owner: "developer",
  },
  meta_description_missing: {
    title: (n) => `${pages(n)} ${v(n, "has", "have")} no meta description`,
    why: "The snippet under the result is then whatever Google chooses to quote.",
    how: "Write a one-sentence description of each page, under 155 characters.",
    owner: "founder",
  },
  h1_missing: {
    title: (n) => `${pages(n)} ${v(n, "has", "have")} no H1 heading`,
    why: "The H1 tells search engines and AI what the page is about. Without one they guess.",
    how: "Add one H1 per page that matches the title's intent.",
    owner: "developer",
  },
  h1_multiple: {
    title: (n) => `${pages(n)} ${v(n, "has", "have")} more than one H1 heading`,
    why: "Several H1s means the page does not say which one thing it is about.",
    how: "Keep one H1 per page and turn the others into H2s.",
    owner: "developer",
  },
  sitemap_missing: {
    title: () => "No sitemap was found",
    why: "Search engines have to discover every page by following links, and some never get found.",
    how: "Publish a sitemap.xml and list it in robots.txt with a 'Sitemap:' line.",
    owner: "developer",
  },
  schema_absent: {
    title: () => "No page we read declares structured data",
    why: "Structured data is what lets a result show ratings, prices or FAQs instead of a plain blue link.",
    how: "Add Schema.org JSON-LD, starting with Organization on the home page and the type that fits each key page.",
    owner: "developer",
  },
  schema_missing_page: {
    title: (n) => `${pages(n)} ${v(n, "carries", "carry")} no structured data`,
    why: "Other pages on the site declare it, so these ones miss the richer result the rest can get.",
    how: "Add the Schema.org JSON-LD type that fits each page.",
    owner: "developer",
  },
  title_too_long: {
    title: (n) => `${pages(n)} ${v(n, "has", "have")} a title over 60 characters`,
    why: "Search results often cut a title that long, so the end of it may never show.",
    how: "Shorten each title to under 60 characters, with the words that matter first.",
    owner: "founder",
  },
};
