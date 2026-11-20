
import type { PlatformSpec } from "./_shared";

export const sms: PlatformSpec = {
  name: "SMS",
  description: "Checks the texting rules for you and writes compliant messages",
  charLimit: 160,
  settings: [
    {
      kind: "choice",
      id: "number_route",
      label: "The number you'd text from",
      help: "Saved and handed to the next run. Which route you are on decides what has to clear before a text is delivered.",
      options: [
        { value: "none", label: "None yet" },
        { value: "toll_free", label: "Toll-free, verified" },
        { value: "ten_dlc", label: "10DLC, registered" },
      ],
    },
    {
      kind: "list",
      id: "moments",
      label: "Moments worth a text",
      help: "A booked time, a state change someone is waiting on, a deadline they chose. If it would matter as much read three hours later, it is an email.",
    },
  ],
};
