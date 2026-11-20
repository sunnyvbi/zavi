
export type AgentCorpusTask = {
  task_id: string;
  agent_slug: string;
  system: string;
  prompt: string;
};

export const AGENT_CORPUS: AgentCorpusTask[] = [
  {
    task_id: "engineer-1",
    agent_slug: "engineer",
    system:
      "You are Zavi's engineer agent. You propose concrete, mergeable code changes for the customer's repo.",
    prompt:
      "A customer's Node/Express API intermittently returns 500s on POST /webhooks/stripe under load. Logs show 'Cannot set headers after they are sent to the client' and the handler does `await db.insert(...)` then `res.json(...)`, but also has an early `if (!sig) return res.status(400).send('no sig')` followed by more code that still runs because the early return is inside a forEach callback, not the handler. Propose the exact fix (what to change and why), and call out any second latent bug you see in this pattern.",
  },
  {
    task_id: "engineer-2",
    agent_slug: "engineer",
    system:
      "You are Zavi's engineer agent. You review proposed engineering approaches before code is written.",
    prompt:
      "A teammate proposes adding a Redis cache in front of every Postgres read in our multi-tenant SaaS to fix slow dashboards, keyed by `user:${userId}`. We have ~100 tenants, RLS on every table, and the slow dashboard is one tenant-admin endpoint doing 6 sequential queries. Review this approach: is Redis the right call here? What's the cross-tenant risk in that cache key, and what would you do instead? Be specific.",
  },
  {
    task_id: "engineer-3",
    agent_slug: "engineer",
    system:
      "You are Zavi's engineer agent. You root-cause production bugs from incomplete evidence.",
    prompt:
      "Since a deploy 3 hours ago, ~1 in 20 background jobs silently never complete — no error, no log, the row stays `status='running'` forever. The deploy added a `Promise.all([sendEmail(), writeAudit()])` inside the job, replacing two sequential awaits. sendEmail() calls a flaky vendor. Root-cause why jobs wedge in 'running', and give the smallest fix that makes a partial failure observable AND recoverable.",
  },

  {
    task_id: "pm-1",
    agent_slug: "pm",
    system:
      "You are Zavi's PM agent. You prioritize ruthlessly against company stage and impact.",
    prompt:
      "We have 100 paying B2B customers ($99-$1299/agent/mo). Backlog this sprint: (a) SSO/SAML, requested by 2 prospects in a $40k deal; (b) a 1-click 'pause agent' button, requested by 11 current customers who fear runaway spend; (c) a new social-media agent, founder's pet idea, 0 requests; (d) fixing a flaky onboarding step where ~15% of new signups stall. Rank these for THIS sprint with a one-line rationale each, and name the one you'd cut entirely.",
  },
  {
    task_id: "pm-2",
    agent_slug: "pm",
    system:
      "You are Zavi's PM agent. You write tight, buildable specs.",
    prompt:
      "Spec the 'pause agent' feature: a customer must be able to instantly halt one agent (stop scheduled runs + in-flight work) and resume later. Cover the user-visible states, what happens to an in-flight run mid-pause, billing implications while paused, and the 3 edge cases most likely to cause a support ticket. Keep it to what an engineer can build this week.",
  },
  {
    task_id: "pm-3",
    agent_slug: "pm",
    system:
      "You are Zavi's PM agent. You cut scope to ship.",
    prompt:
      "Eng says the 'agent activity timeline' feature (show every action each agent took, with filters, search, export, and per-action drill-down) is 4 weeks. We have a churn-risk customer asking 'what is my agent actually doing?' who renews in 8 days. Cut this to a 3-day v0 that meaningfully answers that customer's question. State exactly what's in and what's deferred, and the one thing you refuse to cut.",
  },

  {
    task_id: "advisor-1",
    agent_slug: "advisor",
    system:
      "You are Zavi's advisor agent — a strategic counsel to the founder, evidence-driven and direct.",
    prompt:
      "The founder is deciding whether to raise a seed round now (100 customers, ~$45k MRR, growing 12%/mo, 14 months runway) or wait 6 months to hit $1M ARR for a better valuation. A competitor just raised $30M. Give your strategic call with the 2-3 factors that actually decide this, the strongest argument for the option you DON'T pick, and what single piece of missing information would change your answer.",
  },
  {
    task_id: "advisor-2",
    agent_slug: "advisor",
    system:
      "You are Zavi's advisor agent. You surface the non-obvious risk in a plan.",
    prompt:
      "The founder wants to drop per-agent pricing ($99-$1299/agent) and move to a flat $499/mo all-agents plan, because two churned customers said per-agent 'felt nickel-and-dimey.' Pressure-test this: who does the flat plan quietly hurt, what does it do to expansion revenue, and is the churn signal strong enough to act on? Recommend a decision and a cheaper way to test it first.",
  },
  {
    task_id: "advisor-3",
    agent_slug: "advisor",
    system:
      "You are Zavi's advisor agent. You make the hard call when the data is ambiguous.",
    prompt:
      "Our best engineer-agent customer (paying $1299/mo, a logo we cite in sales) is demanding we build a custom integration that only they need, threatening to leave. It's ~3 weeks of eng for a feature 0 other customers want. We're a small team. Make the call: build it, refuse, or a third option — and give the line you'd actually say to them.",
  },

  {
    task_id: "chief-of-staff-1",
    agent_slug: "chief-of-staff",
    system:
      "You are Zavi's chief-of-staff agent. You prioritize across the whole agent fleet and surface what the founder must see.",
    prompt:
      "Produce today's founder digest from these fleet signals: performance-marketer flagged ROAS dropped 30% on the main Google campaign; support-lead has 4 unresolved tickets aging >48h including one churn-threat; engineer opened 2 PRs awaiting review; growth-lead's last experiment hit significance (signup +8%); a customer's monthly spend is 90% to their cost cap with 9 days left in the cycle. Tier these by what needs the founder's attention TODAY vs FYI, and name the single highest-priority item with why.",
  },
  {
    task_id: "chief-of-staff-2",
    agent_slug: "chief-of-staff",
    system:
      "You are Zavi's chief-of-staff agent. You hold the fleet accountable to what it committed.",
    prompt:
      "Last week the fleet committed: engineer to ship the pause-agent feature, growth-lead to launch 1 new channel test, support-lead to clear the >48h ticket backlog. Actuals: pause-agent PR is open but unreviewed, growth-lead launched the test (early but live), support backlog grew from 4 to 7. Write the committed-vs-delivered accountability block: who delivered, who slipped, the one intervention you'd make this week, and how you'd phrase the miss to the founder without burying it.",
  },
  {
    task_id: "chief-of-staff-3",
    agent_slug: "chief-of-staff",
    system:
      "You are Zavi's chief-of-staff agent. You resolve cross-agent contention.",
    prompt:
      "Two agents want the same scarce resource this week: the engineer needs founder review-time to merge a reliability fix, and growth-lead needs founder sign-off to flip a pricing-page experiment live. The founder has ~30 minutes of decision bandwidth today. Decide the order, justify it against company stage (100 customers, reliability complaints rising), and say what you'd tell the agent who has to wait.",
  },

  {
    task_id: "company-founder-1",
    agent_slug: "company-founder",
    system:
      "You are Zavi's company-founder agent. You make positioning and category decisions.",
    prompt:
      "Zavi is 'an AI cofounder team for any company.' A competitor (Polsia) markets 'AI that runs your company while you sleep — zero employees.' Our real differentiator is human-in-the-loop approval + agents shaped by real operating data (proven on a $1.2M marketplace), not full autonomy. Decide our sharpest one-sentence positioning against them, and defend why NOT to chase the 'zero employees' claim even though it sounds bigger.",
  },
  {
    task_id: "company-founder-2",
    agent_slug: "company-founder",
    system:
      "You are Zavi's company-founder agent. You make the bet-the-company calls.",
    prompt:
      "We can pursue exactly one wedge for the next two quarters: (a) go deep on engineering teams (engineer + qa agents, dev-tool GTM), (b) go deep on growth/marketing teams (performance-marketer + growth-lead + content), or (c) stay horizontal 'whole cofounder team.' We have 100 customers spread across all three today. Pick the wedge, state what you're explicitly saying no to, and the leading indicator that would tell you in 60 days the bet is working.",
  },
  {
    task_id: "company-founder-3",
    agent_slug: "company-founder",
    system:
      "You are Zavi's company-founder agent. You decide under existential constraint.",
    prompt:
      "Runway is 9 months. Growth is real but slow (12%/mo). You can either (a) cut burn to extend to 16 months and grow slower, or (b) keep spending and bet on hitting metrics that unlock a raise in month 7. Make the call, name the single metric you'd stake the decision on, and the pre-commitment trigger that would force you to switch plans.",
  },

  {
    task_id: "content-design-1",
    agent_slug: "content-design",
    system:
      "You are Zavi's content-design agent (a content designer). You start from a user need and propose the clearest content that meets it.",
    prompt:
      "Write a content brief for a blog post targeting the keyword 'AI agents for startups' (mid-funnel, our ICP is seed-stage B2B founders). Include the search intent, the angle that beats the generic listicles already ranking, the H2 outline, the primary + 3 secondary keywords, the internal link targets (our pricing + the engineer-agent feature page), and the one-sentence meta description.",
  },
  {
    task_id: "content-design-2",
    agent_slug: "content-design",
    system:
      "You are Zavi's content-design agent (a content designer). You rewrite weak copy to be sharp and on-brand.",
    prompt:
      "Rewrite this homepage hero to be concrete and credible, not hypey: 'Zavi is the revolutionary AI-powered platform that leverages cutting-edge agents to transform how your business operates at scale.' Our real story: a team of AI agents (engineer, growth, support, etc.) shaped by data from a real $1.2M marketplace, with human approval on every action. Give the new headline + subhead + primary CTA, and a one-line note on what you cut and why.",
  },
  {
    task_id: "content-design-3",
    agent_slug: "content-design",
    system:
      "You are Zavi's content-design agent (a content designer). You diagnose and fix a content problem.",
    prompt:
      "Our /pricing page dropped from position 6 to 14 for 'AI cofounder pricing' over 4 weeks. Nothing changed on the page; a competitor published a detailed pricing-comparison guide. Diagnose the likely cause and give the 3 concrete on-page changes you'd make to recover, in priority order, plus the one thing you would NOT do (over-optimization trap).",
  },

  {
    task_id: "growth-lead-1",
    agent_slug: "growth-lead",
    system:
      "You are Zavi's growth-lead agent. You design rigorous growth experiments.",
    prompt:
      "Activation is our problem: 38% of signups never connect a single data source (Slack/GitHub/ads), and those never activate. Design the highest-leverage experiment to fix this: the hypothesis, the exact change you'd test, the primary metric + guardrail metric, the sample size logic at our volume (~120 signups/week), and how you'd avoid fooling yourself with a vanity lift.",
  },
  {
    task_id: "growth-lead-2",
    agent_slug: "growth-lead",
    system:
      "You are Zavi's growth-lead agent. You pick channels with discipline.",
    prompt:
      "We have $8k/mo to spend acquiring B2B SaaS founders. Options on the table: Google Search (high intent, ~$14 CPC on our terms), LinkedIn ads (precise targeting, expensive), founder-community sponsorships (cheap, unproven attribution), and SEO content (slow, compounding). Pick where the next $8k goes and in what split, justify it against a 100-customer company that needs payback inside 90 days, and name the channel you'd kill if forced.",
  },
  {
    task_id: "growth-lead-3",
    agent_slug: "growth-lead",
    system:
      "You are Zavi's growth-lead agent. You diagnose funnel drop-offs from data.",
    prompt:
      "Funnel last 30 days: 4,800 landing visits → 410 signups (8.5%) → 256 connected a source (62%) → 71 ran an agent (28%) → 22 converted to paid (31%). Identify the single worst leak relative to a healthy B2B SaaS funnel, give your best hypothesis for WHY it's leaking there, and the one diagnostic you'd run before spending a dollar of eng time on a fix.",
  },

  {
    task_id: "performance-marketer-1",
    agent_slug: "performance-marketer",
    system:
      "You are Zavi's performance-marketer agent. You manage paid budgets to a target ROAS.",
    prompt:
      "Across 4 Google campaigns this week: Brand (spend $600, ROAS 9.1), Competitor-terms (spend $2,100, ROAS 1.4), Generic 'ai agents' (spend $3,200, ROAS 0.7), Retargeting (spend $900, ROAS 4.8). Total budget is fixed at $6,800/wk, target blended ROAS ≥ 3.0. Recommend the exact budget reallocation (per campaign, with dollar amounts), justify each move, and flag which cut risks a delayed-conversion false-negative.",
  },
  {
    task_id: "performance-marketer-2",
    agent_slug: "performance-marketer",
    system:
      "You are Zavi's performance-marketer agent. You brief high-converting ad creative.",
    prompt:
      "Our best-performing ad angle ('replace your missing cofounders with AI agents') is fatiguing — CTR fell from 2.1% to 0.9% over 3 weeks at the same spend. Brief 3 distinct new creative concepts to test (each: hook, primary visual idea, one-line body, CTA), each attacking a different buyer motivation, and say which one you'd ship first and why.",
  },
  {
    task_id: "performance-marketer-3",
    agent_slug: "performance-marketer",
    system:
      "You are Zavi's performance-marketer agent. You investigate metric anomalies before reacting.",
    prompt:
      "Yesterday CPA spiked from $180 to $640 on the main campaign while spend and impressions were flat. Conversions in the ad platform show 4 vs the usual ~14. Before you pause anything, walk through the 4 most likely explanations in order of probability (including tracking/attribution causes, not just performance), what you'd check for each, and the one action you would NOT take yet.",
  },

  {
    task_id: "qa-1",
    agent_slug: "qa",
    system:
      "You are Zavi's qa agent. You write thorough, prioritized test plans.",
    prompt:
      "Engineering just shipped the 'pause agent' feature (stop scheduled + in-flight runs, resume later, no billing while paused). Write a test plan: the critical-path happy cases, the 5 highest-risk edge cases (concurrency, billing boundary, pause-during-in-flight-run, resume after schedule window passed, double-pause), and which 3 you'd gate the release on vs which you'd ship-and-watch.",
  },
  {
    task_id: "qa-2",
    agent_slug: "qa",
    system:
      "You are Zavi's qa agent. You triage incoming bug reports into actionable severity.",
    prompt:
      "Triage these 4 reports into P0/P1/P2/P3 with a one-line justification each, and say which one you'd escalate to a page right now: (a) a customer sees another tenant's agent name in an autocomplete dropdown; (b) the dashboard chart is off by one day in the customer's timezone; (c) signup OAuth fails ~5% of the time with a generic error; (d) the 'export CSV' button is misaligned on Safari. Then name the test you'd add to prevent the worst one from recurring.",
  },
  {
    task_id: "qa-3",
    agent_slug: "qa",
    system:
      "You are Zavi's qa agent. You design tests that catch the bug that shipped.",
    prompt:
      "A regression shipped: under load, two agent runs for the same tenant occasionally share a context object and one run's output leaked the other's prompt into a Slack message. The fix added per-run isolation. Write the specific tests (unit + integration) that would have caught this before release AND that prevent regression, including how you'd reproduce the concurrency deterministically in a test.",
  },

  {
    task_id: "research-1",
    agent_slug: "research",
    system:
      "You are Zavi's research agent. You synthesize findings into a decision-ready brief.",
    prompt:
      "The founder asks: 'Should we add a native Salesforce integration?' Synthesize a decision brief from what's knowable: who in our ICP uses Salesforce, what the integration would unlock for which agents, the build cost vs a Zapier-style stopgap, the 2 strongest reasons for and against, and your recommendation with the confidence level and what evidence would raise that confidence.",
  },
  {
    task_id: "research-2",
    agent_slug: "research",
    system:
      "You are Zavi's research agent. You compare options rigorously and avoid false balance.",
    prompt:
      "Compare three vector databases for our episodic agent-memory store (per-tenant isolation, ~10k-1M vectors/tenant, ~100 tenants, must run cheap): pgvector (we already run Postgres), Pinecone, and Qdrant self-hosted. Compare on isolation model, ops burden, cost at our scale, and migration risk. Don't be falsely balanced — make a recommendation and say what would change it.",
  },
  {
    task_id: "research-3",
    agent_slug: "research",
    system:
      "You are Zavi's research agent. You surface the risk a plan is ignoring.",
    prompt:
      "The team plans to let agents auto-execute refunds up to $50 without human approval to cut support latency. Research the risk surface: what's the realistic abuse/error exposure at 100 customers, what do comparable products gate on, the controls that would make this safe, and the single failure mode most likely to bite us that the team probably hasn't considered.",
  },

  {
    task_id: "support-lead-1",
    agent_slug: "support-lead",
    system:
      "You are Zavi's support-lead agent. You de-escalate angry customers without giving away the store.",
    prompt:
      "A customer emails, furious: 'Your engineer agent opened a PR that broke our staging deploy and nobody warned me. This is unacceptable, I'm cancelling.' On investigation: the agent's PR was correct but the customer had auto-merge on and a flaky test masked the break; it's partly our UX (we didn't surface the risk) and partly their config. Draft the reply: de-escalate, take appropriate ownership without admitting fault we don't own, and give a concrete next step that retains them.",
  },
  {
    task_id: "support-lead-2",
    agent_slug: "support-lead",
    system:
      "You are Zavi's support-lead agent. You handle policy edge cases consistently.",
    prompt:
      "A customer on the monthly plan asks for a refund for the past 2 months because they 'barely used it' (they ran agents 3 times). Our policy: no refunds for used months, but we can offer a goodwill credit at our discretion; we don't want to set a precedent that usage-shaming earns refunds, but this is a referenceable logo. Decide the response, the exact offer (if any), and the principle you're applying so the next agent handles a similar case the same way.",
  },
  {
    task_id: "support-lead-3",
    agent_slug: "support-lead",
    system:
      "You are Zavi's support-lead agent. You resolve a multi-issue ticket cleanly.",
    prompt:
      "One ticket contains three things: (1) a real bug — the agent's Slack message posted to the wrong channel; (2) a feature request — 'can it post to multiple channels?'; (3) a billing question — 'why did my invoice go up $99?'. Untangle these: what you resolve now vs route elsewhere, the order you address them in the reply, and the one you must NOT conflate with the others. Draft the reply structure.",
  },

  {
    task_id: "dispute-response-1",
    agent_slug: "dispute-response",
    system:
      "You are Zavi's dispute-response agent. You build compelling evidence for Stripe chargebacks.",
    prompt:
      "Chargeback reason: 'fraudulent' (cardholder claims they didn't authorize it). Facts: the customer signed up with a verified work email, completed OAuth to their own GitHub org, ran 9 agent sessions over 3 weeks from the same IP/device, and the disputed charge is their 2nd monthly renewal. Outline the compelling-evidence response: which specific evidence items prove authorized use, how you'd frame the 'this is a recurring authorized subscription, not fraud' argument, and the single strongest exhibit.",
  },
  {
    task_id: "dispute-response-2",
    agent_slug: "dispute-response",
    system:
      "You are Zavi's dispute-response agent. You handle 'duplicate' charge disputes precisely.",
    prompt:
      "Chargeback reason: 'duplicate' — customer claims they were charged twice for the same thing. Facts: there ARE two charges 4 days apart, but one is the monthly subscription renewal and the other is a one-time charge for an add-on agent they enabled mid-cycle (with an in-app confirmation timestamp). Outline the response that proves these are two DIFFERENT transactions, the comparison table you'd present, and the exact field/evidence that defeats the 'duplicate' claim.",
  },
  {
    task_id: "dispute-response-3",
    agent_slug: "dispute-response",
    system:
      "You are Zavi's dispute-response agent. You respond to 'product unacceptable / not as described' disputes.",
    prompt:
      "Chargeback reason: 'product not as described / unacceptable' — customer claims 'the AI agents didn't do what was promised.' Facts: they ran 12 agent sessions that produced outputs (PRs, reports, replies) which they viewed and downloaded; our marketing promises 'AI agents that do real work,' not specific outcomes. Outline the response: how you'd show the product was delivered and used as described, where the line is between 'didn't like the results' and 'not as described,' and the strongest factual exhibit.",
  },

  {
    task_id: "social-1",
    agent_slug: "social",
    system:
      "You are Zavi's social agent. You draft on-brand social posts that earn engagement, not cringe.",
    prompt:
      "Draft a LinkedIn post for the founder announcing a real milestone: Zavi crossed 100 paying customers, and the product was itself partly built by Zavi's own engineer agent. The brand voice is credible-builder, anti-hype, specific. Write the post (hook + body + soft CTA), keep it under 180 words, avoid em-dashes and AI-slop phrasing, and give the one-line reason your hook works.",
  },
  {
    task_id: "social-2",
    agent_slug: "social",
    system:
      "You are Zavi's social agent. You turn a product fact into a thread.",
    prompt:
      "Turn this into a 5-tweet thread for a founder audience: 'Zavi's agents are shaped by data from a real $1.2M/yr marketplace (Upcar), not a synthetic demo — that's why they make decisions a generic LLM wrapper can't.' Each tweet should stand alone, the first must stop the scroll, and the last should have a non-salesy CTA. No hashtag spam, no em-dashes.",
  },
  {
    task_id: "social-3",
    agent_slug: "social",
    system:
      "You are Zavi's social agent. You respond to a public comment with judgment.",
    prompt:
      "A respected founder publicly comments on our launch post: 'Cool, but isn't this just a wrapper around Claude/GPT? What stops me from building this myself in a weekend?' Draft the founder's public reply: respectful, confident, specific about the real moat (operating-data-shaped agents + human-in-the-loop + multi-tenant memory), no defensiveness, under 80 words, and say in one line what tone you're deliberately NOT taking.",
  },

  {
    task_id: "outbound-sdr-1",
    agent_slug: "outbound-sdr",
    system:
      "You are Zavi's outbound-sdr agent. You write cold emails that get replies, not unsubscribes.",
    prompt:
      "Write a cold email to the founder of a 12-person seed-stage B2B SaaS who just posted on LinkedIn that they 'can't afford to hire a growth person yet.' Sell Zavi's growth-lead + performance-marketer agents. Constraints: subject line + body under 90 words, one specific personalized opener tied to their post, one concrete value claim (not 'revolutionize'), a low-friction CTA (not 'book a demo'), no em-dashes.",
  },
  {
    task_id: "outbound-sdr-2",
    agent_slug: "outbound-sdr",
    system:
      "You are Zavi's outbound-sdr agent. You write follow-ups that add value, not guilt.",
    prompt:
      "Your first cold email to a prospect (a Series A eng leader) got opened twice but no reply. Write follow-up #2: a different angle from the first (which pitched the engineer agent broadly), under 60 words, leading with a specific proof point (the engineer agent opened a real merged PR that fixed a production 500), and a single yes/no CTA. Say in one line why you changed the angle instead of 'just checking in.'",
  },
  {
    task_id: "outbound-sdr-3",
    agent_slug: "outbound-sdr",
    system:
      "You are Zavi's outbound-sdr agent. You qualify and route, not spray.",
    prompt:
      "You have 40 leads scraped from a 'who's hiring' board. 18 are hiring senior engineers, 9 are hiring growth/marketing, 13 are hiring generalist ops. Zavi's strongest wedge right now is the engineer + qa agents. Decide how you'd segment and sequence outreach across these 40 (who first, what message variant per segment, who you'd DEPRIORITIZE), and the one signal you'd use to disqualify a lead before emailing.",
  },

  {
    task_id: "browser-operator-1",
    agent_slug: "browser-operator",
    system:
      "You are Zavi's browser-operator agent. You decompose a browser task into safe, verifiable steps.",
    prompt:
      "Task: 'Go to our Google Ads account and pause the campaign named Generic-AI-Agents because its ROAS is below target.' Decompose this into an explicit step-by-step plan a browser agent would execute, including the verification step after each action, the exact point a human approval should gate (before the irreversible/spend-affecting action), and the 2 failure states (campaign renamed, 2FA prompt) you'd handle and how.",
  },
  {
    task_id: "browser-operator-2",
    agent_slug: "browser-operator",
    system:
      "You are Zavi's browser-operator agent. You plan a multi-page data-gathering task without taking destructive actions.",
    prompt:
      "Task: 'Pull this month's invoice total and the next billing date from our Stripe dashboard, and the current MRR from the same screen.' Plan the read-only navigation: the pages/clicks in order, how you'd confirm you're reading the RIGHT numbers (not a cached or filtered view), what you'd do if a number is ambiguous, and the explicit guardrail that prevents you from clicking anything that changes state.",
  },
  {
    task_id: "browser-operator-3",
    agent_slug: "browser-operator",
    system:
      "You are Zavi's browser-operator agent. You recover from a mid-task failure safely.",
    prompt:
      "Mid-task ('update the company billing email in the SaaS vendor portal'), after you click Save, the page shows a spinner that never resolves and you can't tell if the change persisted. Decide the safe recovery: how you determine the actual state without blindly re-submitting (risking a double-change), what you report back to the human, and the rule you follow about retrying a write whose outcome is unknown.",
  },
];
