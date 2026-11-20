
export type Starter = {
  id: string;
  title: string;
  prompt: string;
  produces: string;
  needs: string;
  agent: string;
  agentLabel: string;
  tool: string;
  note?: string;
  needsConnection?: boolean;
};

export type StarterGroup = {
  id: string;
  title: string;
  blurb: string;
  starters: Starter[];
};

export const STARTER_GROUPS: readonly StarterGroup[] = [
  {
    id: "documents",
    title: "Write it up",
    blurb: "A finished document you can send to someone.",
    starters: [
      {
        id: "monthly-report",
        title: "A report on how the business is doing",
        prompt:
          "Write me a one-page report on how the business did this month, with the numbers you can actually verify, and send it as a PDF.",
        produces: "A PDF, attached to the reply",
        needs: "Nothing to connect. It uses whatever it can read plus what you tell it.",
        agent: "operator",
        agentLabel: "Operator",
        tool: "report__render_pdf",
      },
      {
        id: "evidence-packet",
        title: "A document that makes a case",
        prompt:
          "Put together a short evidence packet on this, laying out what happened, what the data shows, and what I should do about it. PDF please.",
        produces: "A PDF, attached to the reply",
        needs: "The situation, in your own words. It will ask if it needs more.",
        agent: "research",
        agentLabel: "Research",
        tool: "report__render_pdf",
      },
      {
        id: "blog-post",
        title: "A blog post, ready to publish",
        prompt:
          "Draft a blog post about this for our site. Give me the finished piece with images, not an outline.",
        produces: "An HTML file with up to 3 generated hero images",
        needs: "The topic and roughly who it is for.",
        agent: "content-design",
        agentLabel: "Content Design",
        tool: "report__render_blog",
        note: "Hero images are capped at 3 per post and each one is a billed generation (about 1 credit).",
      },
    ],
  },
  {
    id: "decks",
    title: "Present it",
    blurb: "Slides you can walk someone through or forward.",
    starters: [
      {
        id: "deck",
        title: "A deck I can actually present",
        prompt:
          "Build me a deck on where the business stands right now: the numbers, the one real constraint, and what I am proposing we do.",
        produces: "A landscape 16:9 PDF, plus a link that opens the deck in a browser",
        needs: "The topic and the audience. Real figures come from what it can verify.",
        agent: "pm",
        agentLabel: "PM",
        tool: "report__render_deck",
        note:
          "The link is PUBLIC and unauthenticated: anyone who has the address can open the deck without signing in, and it stays live for 30 days. The PDF is private. Your workspace can turn the link off, and the PDF alone is still a complete deck. Caps at 12 slides per deck.",
      },
      {
        id: "board-update",
        title: "A board or investor update",
        prompt:
          "Turn this quarter into a board update deck. Lead each slide with the claim, not a label, and only use numbers you can stand behind.",
        produces: "A landscape 16:9 PDF, plus a browser link",
        needs: "The period you want covered.",
        agent: "growth-lead",
        agentLabel: "Growth Lead",
        tool: "report__render_deck",
        note:
          "Same public link caveat as above: anyone with the address can read it without signing in. Think before you forward a board deck link.",
      },
    ],
  },
  {
    id: "data",
    title: "Get the data out",
    blurb: "Rows and numbers you can sort, filter and pivot yourself.",
    starters: [
      {
        id: "xlsx",
        title: "A spreadsheet I can pivot",
        prompt:
          "Pull this into a real Excel spreadsheet with proper typed columns so I can sort and pivot it myself.",
        produces: "An .xlsx workbook with typed columns and real numbers",
        needs: "What you want in it. Live data needs the matching connector.",
        agent: "operator",
        agentLabel: "Operator",
        tool: "report__render_xlsx",
        needsConnection: true,
        note:
          "Ask for this rather than a PDF table whenever you intend to do your own maths on it. A PDF of numbers is not data.",
      },
      {
        id: "csv",
        title: "A CSV for another system",
        prompt: "Give me this as a CSV I can import somewhere else.",
        produces: "A .csv file",
        needs: "What rows you want.",
        agent: "operator",
        agentLabel: "Operator",
        tool: "report__render_csv",
        note: "CSV carries text only. If a human is going to read it, ask for the spreadsheet instead.",
      },
    ],
  },
  {
    id: "social",
    title: "Post it",
    blurb: "Images with your words on them, in your brand colours.",
    starters: [
      {
        id: "social-post",
        title: "A branded post image",
        prompt:
          "Make me a launch post image for this, in our brand colours, with the headline and the offer on it.",
        produces: "Up to 3 different treatments of the same idea to choose between",
        needs:
          "Your brand hex codes, or a working link to your site so it can read them.",
        agent: "performance-marketer",
        agentLabel: "Performance Marketer",
        tool: "report__render_social_image",
        note:
          "Without a readable site or your hexes it falls back to placeholder colours, and it will tell you it did rather than pass them off as your brand. Each of the 3 options is a billed image generation.",
      },
      {
        id: "carousel",
        title: "A swipeable carousel",
        prompt:
          "Turn this into a carousel post: a hook, one point per slide, and a call to action at the end.",
        produces: "An ordered set of 2 to 10 panels, auto-named in posting order",
        needs: "The story you want told, and your brand colours as above.",
        agent: "growth-lead",
        agentLabel: "Growth Lead",
        tool: "report__render_social_image",
        note:
          "At most 3 panels can carry a photo (those are the billed ones). The rest render as type-only cards in your colours and cost nothing, which is what a good carousel looks like anyway.",
      },
      {
        id: "plain-image",
        title: "A plain photo, no words",
        prompt: "Generate a few images for this. No text on them.",
        produces: "Up to 5 images per request",
        needs: "A description of the picture you want.",
        agent: "operator",
        agentLabel: "Operator",
        tool: "report__generate_image",
        note:
          "For anything with words on it, use the branded post above instead. Image models mangle text. There is a daily cap on generations; if you hit it you are told which images were skipped and why.",
      },
    ],
  },
  {
    id: "prototypes",
    title: "See it before you build it",
    blurb: "A screen you can click through, instead of a description of one.",
    starters: [
      {
        id: "wireframe",
        title: "A clickable prototype of a screen",
        prompt:
          "Build me a clickable prototype of this screen so I can actually click through the flow, not a description of it.",
        produces: "A link to a working HTML prototype with real buttons and a state machine",
        needs: "The screen or flow you want to feel.",
        agent: "pm",
        agentLabel: "PM",
        tool: "report__render_wireframe",
        note:
          "The prototype is reachable by link, so it is built with invented placeholder data on purpose. Never ask it to put your real customer data in one.",
      },
    ],
  },
];

export const TOOLS_PATH = "/tools";

export function toolUseHref(id: string): string {
  return `${TOOLS_PATH}?use=${encodeURIComponent(id)}`;
}

export function toolLoginHref(id: string): string {
  return `/login?next=${encodeURIComponent(toolUseHref(id))}`;
}

export const ALL_STARTERS: readonly Starter[] = STARTER_GROUPS.flatMap((g) => g.starters);

export const KNOWN_REPORT_TOOLS: readonly string[] = [
  "report__render_pdf",
  "report__render_csv",
  "report__render_xlsx",
  "report__render_blog",
  "report__render_wireframe",
  "report__render_deck",
  "report__generate_image",
  "report__render_social_image",
];
