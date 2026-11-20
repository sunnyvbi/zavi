import type { AnchorHTMLAttributes } from "react";
import { buttonClassName, type ButtonVariant } from "./Button";

export function LinkButton({ className, variant = "secondary", ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant }) {
  return <a className={buttonClassName(variant, className)} {...props} />;
}
