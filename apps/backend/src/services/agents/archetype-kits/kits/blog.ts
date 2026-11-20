import type { ArchetypeKit } from "@/services/agents/archetype-kits/types";

export const BLOG_KIT: ArchetypeKit = {
  slug: "blog",
  title: "Blog or publication",
  summary:
    "A reader-first publication: an index of articles, a typographically serious " +
    "reading page, topic pages, and an author-only editor. Optimised for reading " +
    "and for being found — every article is server-rendered with real metadata " +
    "rather than assembled in the browser.",
  keywords: [
    "blog",
    "newsletter",
    "publication",
    "articles",
    "magazine",
    "essays",
    "writing site",
    "content site",
    "editorial",
    "journal",
    "digital garden",
    "changelog",
    "docs site",
  ],
  pages: [
    {
      route: "/",
      name: "Index",
      purpose: "Latest articles with the most recent featured; the reader decides what to read next here.",
      components: ["SiteHeader", "FeaturedArticle", "ArticleList", "TopicNav", "SubscribeCta", "SiteFooter"],
    },
    {
      route: "/p/[slug]",
      name: "Article",
      purpose: "The reading experience: title, byline, date, body, and a next-article path at the end.",
      components: ["SiteHeader", "ArticleHeader", "ArticleBody", "ShareRow", "NextArticle", "SubscribeCta", "SiteFooter"],
    },
    {
      route: "/topics/[topic]",
      name: "Topic",
      purpose: "Every article under one topic, so a reader who likes one piece can find its siblings.",
      components: ["SiteHeader", "TopicHeader", "ArticleList", "SiteFooter"],
    },
    {
      route: "/admin",
      name: "Editor",
      purpose: "Author-only: write, edit, set a topic, and publish or unpublish.",
      components: ["AdminShell", "MarkdownEditor", "DraftList", "PublishControls"],
    },
  ],
  components: [
    { id: "SiteHeader", description: "Publication name, topic nav, and a subscribe CTA." },
    { id: "FeaturedArticle", description: "Lead article with a larger card: image, title, dek, and read time." },
    { id: "ArticleList", description: "Chronological article cards with title, dek, date, and read time." },
    { id: "TopicNav", description: "Topic chips linking to topic pages." },
    { id: "ArticleHeader", description: "Title, dek, author, publish date, and read time." },
    { id: "ArticleBody", description: "Rendered long-form content with headings, quotes, code blocks, images, and footnotes." },
    { id: "ShareRow", description: "Copy-link and share actions." },
    { id: "NextArticle", description: "Next or related article so the reader never dead-ends at the end of a piece." },
    { id: "SubscribeCta", description: "Email capture writing to the subscribers table." },
    { id: "TopicHeader", description: "Topic name, description, and article count." },
    { id: "AdminShell", description: "Author-only wrapper with an auth guard; the only authenticated surface." },
    { id: "MarkdownEditor", description: "Markdown editing with a live preview and autosave to draft." },
    { id: "DraftList", description: "Drafts and published pieces with their status." },
    { id: "PublishControls", description: "Publish, unpublish, set slug, topic, and publish date." },
    { id: "SiteFooter", description: "About, archive, and RSS links." },
  ],
  schema: [
    {
      name: "articles",
      purpose: "One piece of writing, draft or published.",
      columns: {
        id: "uuid pk",
        slug: "text unique",
        title: "text",
        dek: "text — one-line standfirst under the title",
        body_markdown: "text",
        cover_image: "text",
        topic_id: "uuid → topics",
        author_id: "uuid → authors",
        status: "enum draft/published",
        published_at: "timestamptz — null while draft",
        created_at: "timestamptz",
      },
    },
    {
      name: "topics",
      purpose: "Grouping for articles; powers the topic pages and nav.",
      columns: {
        id: "uuid pk",
        slug: "text unique",
        name: "text",
        description: "text",
      },
    },
    {
      name: "authors",
      purpose: "Bylines. Few rows by design — this is a publication, not a forum.",
      columns: {
        id: "uuid pk → auth user",
        name: "text",
        bio: "text",
        avatar_url: "text",
      },
    },
    {
      name: "subscribers",
      purpose: "Email capture from the subscribe CTA.",
      columns: {
        id: "uuid pk",
        email: "text unique not null",
        created_at: "timestamptz",
      },
    },
  ],
  seedData: [
    "Six to eight published articles of genuinely varied length across two or three topics, so the index, topic pages and read-time estimates all look real.",
    "One draft article so the editor's draft-versus-published distinction is visible.",
    "One author row carrying the founder's own name and bio.",
    "No seeded subscribers — an empty subscribers table is the correct first state.",
  ],
  responsive: [
    "ArticleBody: measure capped near 68ch and centred; never full-bleed text on a wide screen.",
    "ArticleList: single column on mobile, two from lg; the featured article stays full-width.",
    "TopicNav: horizontally scrollable chip row on mobile.",
    "Editor: preview pane hides under lg, toggled by a write/preview switch.",
  ],
  visualDirection: {
    mood: "editorial and quiet — typography is the design; the interface gets out of the way.",
    layout: "single centred reading column with generous line height and clear heading hierarchy.",
    accents: [
      "One serif or high-contrast display face for headings against a highly readable body face.",
      "Links underlined in the body — in running text, colour alone is not enough.",
      "Images full-measure with captions; no decorative chrome around the text.",
    ],
  },
};
