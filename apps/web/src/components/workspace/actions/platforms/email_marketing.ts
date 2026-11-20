
import { MailOpen, MousePointerClick, Users } from "lucide-react";
import type { MetricDisplay, PlatformSpec } from "./_shared";

export const EMAIL_CONNECT_COPY = {
  blurb:
    "Three ways to send. Connect SendGrid, Mailchimp or Klaviyo and Zavi sends to a list there once you approve. Or let Zavi send it for you: verify your domain and add a contact list under Settings. Or copy each draft and send it from your own tool.",
  link: "Connect SendGrid, Mailchimp or Klaviyo so Zavi can send the emails you approve",
  also: "Connect SendGrid, Mailchimp or Klaviyo and Zavi sends to a list there once you approve, or let Zavi send it for you from your own domain under Settings.",
};

const EMAIL_METRICS: Record<string, MetricDisplay> = {
  recipients: { label: "People emailed", icon: Users },
  opens: { label: "Opens", icon: MailOpen },
  clicks: { label: "Clicks", icon: MousePointerClick },
  open_rate: { label: "Open rate", icon: MailOpen },
  click_rate: { label: "Click rate", icon: MousePointerClick },
};

export const email_marketing: PlatformSpec = {
  name: "Email campaigns",
  weekCalendar: false,
  connectCopy: EMAIL_CONNECT_COPY,
  settingsPanels: ["email_template", "email_learnings", "email_sendgrid", "email_test_lists", "email_auto_send", "email_sending_domain", "email_contact_lists", "email_footer"],
  settingsBadge: "email_learnings_new",
  headTools: "email_campaign",
  runIsSecondary: true,
  hideRunCost: true,
  hideAccountSnapshot: true,
  doneHistory: true,
  workCard: true,
  metricDisplay: EMAIL_METRICS,
  execCopy: {
    working: "Zavi is sending your email. This can take a minute.",
    done: "Zavi sent this email.",
    failedTitle: "This email was not sent.",
    partialTitle: "May have gone out. Zavi is checking.",
    failedHint: "Nothing went out. Read the note above, then try again.",
  },
  settings: [
    {
      kind: "list",
      id: "segments",
      label: "Who you email",
      help: "Describe each group in a few words. Zavi reads this before planning emails.",
      placeholder: "e.g. Customers who bought in the last 90 days",
      pausable: false,
      itemTypeOptions: {
        unsetLabel: "Consent not stated",
        label: (item) => `What ${item} agreed to`,
        options: [
          { value: "marketing_optin", label: "Opted in to marketing" },
          { value: "transactional", label: "Customers only" },
          { value: "imported", label: "Imported or bought" },
        ],
      },
    },
  ],
};
