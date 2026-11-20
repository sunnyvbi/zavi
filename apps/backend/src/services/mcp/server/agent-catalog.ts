
export const MCP_AGENT_CATALOG: Readonly<Record<string, { name: string; description: string }>> = {
  operator: {
    name: "Zavi",
    description:
      "Answers questions about your business and hands larger tasks to the right specialist agent.",
  },
  cgo: {
    name: "Chief Growth Officer",
    description:
      "Reads your business and drafts your growth plan: the metric to grow, what holds it back, and the channels worth betting on.",
  },
  "growth-lead": {
    name: "Head of Growth",
    description: "Finds where your funnel loses people and proposes growth bets for you to approve.",
  },
  "performance-marketer": {
    name: "Ads Manager",
    description:
      "Plans paid campaigns and budgets across your ad platforms. Ad changes Zavi makes from a run in your AI client are never applied without your approval in Zavi.",
  },
  "seo-geo": {
    name: "SEO & AI Search",
    description:
      "Audits your own pages for search ranking and for being cited in AI answers, then drafts fixes. It never edits your site.",
  },
  "content-design": {
    name: "Content Designer",
    description:
      "Proposes clearer copy and page content, starting from what your users need. Changes go out only after you approve them.",
  },
  research: {
    name: "Research",
    description: "Researches a question across the public web and returns a report that cites its sources.",
  },
  advisor: {
    name: "Advisor",
    description:
      "Works through a hard strategic decision with you and recommends what to do today, in the next 30 days, and what to watch.",
  },
  "chief-of-staff": {
    name: "Chief of Staff",
    description:
      "Reads your agents' work and your Slack and writes a short digest of what needs your attention today.",
  },
  pm: {
    name: "Product Manager",
    description:
      "Turns recent signals from your workspace into a ranked backlog of fixes and features, and can hand the top items to the Engineer.",
  },
  engineer: {
    name: "Engineer",
    description:
      "Makes code changes to your connected GitHub repository in an isolated sandbox and prepares a pull request for you to approve.",
  },
  qa: {
    name: "QA",
    description: "Writes plain-language test cases for your product and runs them in a read-only browser.",
  },
  "support-lead": {
    name: "Support Lead",
    description:
      "Investigates customer support, payment and trust issues and routes anything irreversible to you. It never issues refunds or bans users.",
  },
  "dispute-response": {
    name: "Dispute Response",
    description:
      "Gathers evidence for a Stripe chargeback and drafts your response. It submits only after you approve.",
  },
  fundraising: {
    name: "Fundraising",
    description:
      "Finds investors who fit your raise stage and gives you a tiered list as a CSV. It never contacts anyone.",
  },
  "supply-demand-balancer": {
    name: "Supply & Demand",
    description:
      "For marketplaces: compares supply and demand in each area and drafts growth actions where they diverge.",
  },
  "onboarding-discovery": {
    name: "Onboarding Discovery",
    description:
      "Learns about your company from your product and the public web, and saves what it finds to your company brain.",
  },
};
