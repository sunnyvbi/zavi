
import { Bookmark, Eye, MousePointerClick, Users } from "lucide-react";
import type { MetricDisplay, PlatformSpec } from "./_shared";
import { LINK, POST_IMAGE, postTextOrZavi } from "../topActions/fieldSets";

export const pinterest_organic: PlatformSpec = {
  name: "Pinterest",
  weekCalendar: false,
  metricDisplay: {
    followers: { label: "Followers", icon: Users },
    impressions: { label: "Impressions", icon: Eye },
    outbound_clicks: { label: "Outbound clicks", icon: MousePointerClick },
    saves: { label: "Saves", icon: Bookmark },
  } satisfies Record<string, MetricDisplay>,
  metricLayout: { perRow: 4 },
  hideAccountSnapshot: true,
  analyticsView: "pinterest",
  planDayLine: false,
  pinCards: true,
  postImageSizes: [{ value: "pin", label: "Standard 2:3" }, { value: "square", label: "Square 1:1" }, { value: "story", label: "Tall 9:16" }],
  overviewPanels: ["pinterest_posted_pins"],
  createMenu: "New pin",
  createDirect: true,
  topActions: [
    {
      key: "create_pin",
      label: "Create a pin",
      modal: "form",
      submit: "social_propose",
      socialChannel: "pinterest_pin",
      lead: "An image, a title and a link, on a board you pick. Write the description, or leave it empty and Zavi writes it.",
      note: "Post sends it to your connected Pinterest account now. Send for approval keeps it on this page until you approve it.",
      fields: [
        POST_IMAGE,
        { kind: "text", name: "title", label: "Title", max: 100, error: "Give the pin a title." },
        postTextOrZavi("Description", 500),
        { kind: "select", name: "board_id", label: "Board", from: "boards", empty: "No public board found. Make one with New board.", disconnected: "Connect Pinterest in Integrations first, then pick or make a public board.", unavailable: "Zavi couldn't load your Pinterest boards. Try again in a minute.", partial: "Pinterest was slow, so some boards may be missing. Find yours by name below.", pinterestBoards: true },
        { ...LINK, hint: "Where people land when they tap the pin. Starts with https://", defaultFrom: "site_url" },
      ],
      primary: "Post",
      done: "Pin waiting for your approval on this page. It posts when you approve.",
      postNow: {
        stageLabel: "Send for approval",
        needsWords: "Write a description to post now, or Send for approval and Zavi writes it.",
      },
      writes: {
        key: "create_pin_write",
        done: "Zavi is writing the description. The pin waits for your approval on this page in a minute or two. Nothing posts until you approve it.",
      },
    },
  ],
  description: "Finds what shoppers save in your niche and hands you three pins ready to upload",
  charLimit: 1200,
  settings: [
    {
      kind: "text",
      id: "handle",
      label: "Your Pinterest account",
      help: "The username after pinterest.com/. It goes to the next run.",
      placeholder: "yourbrand",
    },
    {
      kind: "list",
      id: "competitors",
      label: "Pinterest accounts in your niche",
      help: "Usernames worth comparing against. The next run reads their recent pins and only compares you to accounts it actually read.",
    },
  ],
};
