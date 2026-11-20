
import { renderOtpEmail } from "../src/email/templates/otp";
import { renderResetPasswordEmail } from "../src/email/templates/reset-password";
import { writeFileSync } from "node:fs";

const otp = renderOtpEmail({ code: "482913" });
writeFileSync("/tmp/praxis-otp.html", otp.html);
console.log("→ /tmp/praxis-otp.html  (subject:", otp.subject, ")");

const reset = renderResetPasswordEmail({
  actionUrl: "https://www.zaviagent.com/auth/callback?token=eyJhbGc...&type=recovery&next=/reset-password",
});
writeFileSync("/tmp/praxis-reset.html", reset.html);
console.log("→ /tmp/praxis-reset.html  (subject:", reset.subject, ")");
