
export const AUTOPILOT_ERROR = "Could not save that. Try again.";

export const AUTOPILOT_OWNER_ONLY = "Only owners and admins can change Autopilot.";

export type AutopilotList = { title: string; items: string[] };
export type AutopilotCopy = {
  title: string;
  confirmLabel: string;
  lists: AutopilotList[];
  note: string | null;
};

const ASKS_FIRST: AutopilotList = { title: "Still asks you first", items: ["Spending", "Posts", "Code changes"] };

export function autopilotCopy(turningOn: boolean): AutopilotCopy {
  if (turningOn) {
    return {
      title: "Turn on Autopilot?",
      confirmLabel: "Turn on",
      lists: [
        {
          title: "With Autopilot on, Zavi will",
          items: [
            "Adjust your goals",
            "Pause channels that sit idle",
            "Check in early when a number moves",
            "Start low-risk work itself, like research and SEO",
            "Run your Meta and Google ads inside your ad budget",
          ],
        },
        ASKS_FIRST,
      ],
      note: "Mark any Autopilot change a mistake within 30 days and we undo it and refund the credits it used.",
    };
  }
  return {
    title: "Turn off Autopilot?",
    confirmLabel: "Turn off",
    lists: [
      {
        title: "What stops",
        items: [
          "Goal changes and channel pauses",
          "Early check-ins",
          "New moves toward your goal",
          "Low-risk work Zavi starts itself",
          "Meta and Google ads run under your ad budget",
          "Organic-channel moves you approve after this end as \"Didn't finish\"",
        ],
      },
      {
        title: "What keeps going",
        items: ["Moves already running finish", "Your weekly note, with the changes it would make"],
      },
      ASKS_FIRST,
    ],
    note: null,
  };
}
