
export type Destination =
  | "workspace"
  | "growth_strategy"
  | "channels"
  | "seo_geo"
  | "linkedin_x"
  | "reddit"
  | "visual"
  | "creators"
  | "paid_ads";

export type SequenceStep = {
  step: number;
  day: number;
  subject: string;
  preheader: string;
  headline: string;
  paragraphs: readonly string[];
  afterButton?: string;
  button: string;
  destination: Destination;
  image: string;
  alt: string;
};

export const SEQUENCE_STEPS: readonly SequenceStep[] = [
  {
    step: 1,
    day: 0,
    subject: "Welcome to Zavi",
    preheader: "",
    headline: "Welcome to Zavi",
    paragraphs: [
      "I’m here to help you grow your business. You now have an AI growth agent working with you.",
      "Growth Strategy connects your business goals with a plan. Channels focus on the work behind it: search, content, social media, ads, and creator campaigns.",
      "Over the next few days, I’ll introduce you to each channel. You’ll learn how they work and how to use Growth Strategy to guide your next steps.",
      "For now, take a look around your workspace. This is where we’ll work together.",
    ],
    afterButton: "Your growth plan will be ready in about 15 minutes. I’ll email you when it is.",
    button: "Open Zavi",
    destination: "workspace",
    image: "01-welcome.jpg",
    alt: "Zavi waves beside an open notebook and a growth arrow.",
  },
  {
    step: 2,
    day: 1,
    subject: "Meet your Growth Strategy",
    preheader: "Give me a goal and let Autopilot help keep your growth plan moving.",
    headline: "Meet your Growth Strategy",
    paragraphs: [
      "This is where your business goals become a plan we can work on together.",
      "You might want to increase signups, get more paying customers, or reach a monthly recurring revenue (MRR) target.",
      "I connect your goal with the work across your channels. Your plan helps you see where to focus and why.",
      "Turn on the Autopilot switch and I’ll check progress toward your goal for you.",
      "I review what needs attention, adjust goals, and pause idle channels to keep the plan focused. Running channels for you needs a paid plan.",
      "You can see my updates in Growth Strategy.",
      "Give me your goal, and let’s work toward it together.",
    ],
    button: "Open Growth Strategy",
    destination: "growth_strategy",
    image: "02-growth-strategy.jpg",
    alt: "Zavi marks the next step on a simple growth plan.",
  },
  {
    step: 3,
    day: 2,
    subject: "Help customers find your business",
    preheader: "Let me handle search research and content drafts for Google and AI answers.",
    headline: "Meet your SEO channel and GEO channel",
    paragraphs: [
      "When people need a product or service, they often start with a search. Your search channels help them discover your business.",
      "My SEO channel looks for ways to make your website easier to find on Google. This includes content ideas and improvements to existing pages.",
      "My GEO channel focuses on how your business appears in AI answers. I help prepare content that explains what you offer clearly.",
      "I do the research and write the drafts. You approve before anything changes on your site.",
      "Together, we work toward helping more relevant customers find your business.",
    ],
    button: "Open SEO and GEO",
    destination: "seo_geo",
    image: "03-seo-geo.jpg",
    alt: "Zavi examines a search page with a magnifying glass.",
  },
  {
    step: 4,
    day: 3,
    subject: "Meet your LinkedIn and X channels",
    preheader: "Let me prepare posts that help people get to know and trust your business.",
    headline: "Meet your LinkedIn and X channels",
    paragraphs: [
      "A customer may see your business several times before deciding to buy. Useful posts give them a reason to remember you.",
      "I turn product updates, business stories, and ideas into posts in your voice. I help explain what you offer and why it matters.",
      "You get drafts for LinkedIn and X without starting from a blank page each time.",
      "These channels give you a place to share your work and build trust with potential customers.",
      "I write the posts. You approve each one before it goes out.",
    ],
    button: "Open LinkedIn and X",
    destination: "linkedin_x",
    image: "04-linkedin-x.jpg",
    alt: "Zavi writes a social post beside a conversation bubble.",
  },
  {
    step: 6,
    day: 4,
    subject: "Meet your Reddit channel",
    preheader: "Find useful conversations and build trust with potential customers.",
    headline: "Meet your Reddit channel",
    paragraphs: [
      "People use Reddit to ask questions, compare products, and discuss problems. These conversations can help you understand what your customers need.",
      "I help find relevant communities and discussions about the problems your business solves.",
      "I prepare useful posts or replies for your review. Each draft can explain an idea, answer a question, or offer help.",
      "This gives your business a way to join relevant conversations and build trust with potential customers.",
      "You choose what to share. We can help people understand your business through useful contributions that respect the community.",
    ],
    button: "Open Reddit",
    destination: "reddit",
    image: "06-reddit.jpg",
    alt: "Zavi listens to customer conversations and prepares a reply.",
  },
  {
    step: 7,
    day: 5,
    subject: "Show customers how your product helps",
    preheader: "Turn your product’s value into content customers can see and understand.",
    headline: "Meet your visual channels",
    paragraphs: [
      "Meet your Instagram, TikTok, Pinterest, and YouTube channels.",
      "Some products are easier to understand when people see them in use. A demonstration or product story can make the value clearer.",
      "I help prepare content ideas and video scripts for your business. We can show a product benefit, a common use, or a problem it helps solve.",
      "I help shape the opening, what to show, and what to say. You get a clear starting point for content you can make.",
      "These channels can help attract interest and make your business more familiar to potential customers.",
    ],
    button: "Open visual channels",
    destination: "visual",
    image: "07-visual-video.jpg",
    alt: "Zavi holds a storyboard beside a video camera.",
  },
  {
    step: 8,
    day: 6,
    subject: "Meet your creator channels",
    preheader: "Let me help shape your product story for creators and new audiences.",
    headline: "Meet your creator channels",
    paragraphs: [
      "Creator videos and AI content give you different ways to tell your product story.",
      "In Zavi, you’ll find these as creator UGC and AI UGC channels.",
      "I help prepare a brief that brings your audience, message, format, and intended use together. It gives the campaign a clear direction.",
      "This helps explain what makes your product useful and how it fits into a customer’s life.",
      "Creator content can show your product in use.",
    ],
    button: "Open creator channels",
    destination: "creators",
    image: "08-creators.jpg",
    alt: "Zavi arranges a creator brief and visual idea cards.",
  },
  {
    step: 9,
    day: 7,
    subject: "Meet your paid ads channels",
    preheader: "Connect your ads to a growth goal, with a plan you can review.",
    headline: "Meet your paid ads channels",
    paragraphs: [
      "Paid ads can help you reach people beyond your current audience. They can support goals such as more signups, enquiries, or sales.",
      "I help prepare a campaign plan for channels such as Google and Meta.",
      "I bring the audience, message, budget, and result to measure into one place. I can also help draft the ad message.",
      "You can see how the campaign connects to your business goal before deciding to spend.",
      "This gives you a clear plan for reaching potential customers and learning which message connects with them.",
      "You review the plan and approve spending before launch.",
    ],
    button: "Open paid ads",
    destination: "paid_ads",
    image: "09-paid-ads.jpg",
    alt: "Zavi reviews an ads plan beside a target and budget tokens.",
  },
];

const CHANNEL_FOR: Record<Exclude<Destination, "workspace" | "growth_strategy" | "channels">, string> = {
  seo_geo: "seo",
  linkedin_x: "linkedin_organic",
  reddit: "reddit_organic",
  visual: "instagram_organic",
  creators: "ugc",
  paid_ads: "google_ads",
};

export function channelSlugFor(dest: Destination): string | null {
  return dest === "workspace" || dest === "growth_strategy" || dest === "channels" ? null : CHANNEL_FOR[dest];
}

export function destinationUrl(dest: Destination, workspaceUrl: string, step: number): string {
  const src = `src=onb_${step}`;
  if (dest === "workspace") return `${workspaceUrl}?${src}`;
  if (dest === "growth_strategy") return `${workspaceUrl}?tab=growth-strategy&${src}`;
  if (dest === "channels") return `${workspaceUrl}?tab=channels&${src}`;
  return `${workspaceUrl}?tab=channels&channel=${CHANNEL_FOR[dest]}&${src}`;
}

export function cardUrl(workspaceUrl: string, channelSlug: string, actionId: string, step: number): string {
  return `${workspaceUrl}?tab=channels&channel=${encodeURIComponent(channelSlug)}&action=${encodeURIComponent(actionId)}&src=onb_${step}`;
}

export const ONBOARDING_SRC_RE = /^onb_([1-9][0-9]?)$/;

export const DIGEST_STEP: SequenceStep = {
  step: 10,
  day: 1,
  subject: "Your first results",
  preheader: "",
  headline: "Your first results",
  paragraphs: ["Here is what I found overnight."],
  button: "See all results",
  destination: "channels",
  image: "02-growth-strategy.jpg",
  alt: "Zavi marks the next step on a simple growth plan.",
};

export const ALL_STEPS: readonly SequenceStep[] = [...SEQUENCE_STEPS, DIGEST_STEP];

export function stepByNumber(step: number): SequenceStep | undefined {
  return ALL_STEPS.find((s) => s.step === step);
}

export function nextStepAfter(lastStep: number): SequenceStep | undefined {
  return SEQUENCE_STEPS.find((s) => s.step > lastStep);
}
