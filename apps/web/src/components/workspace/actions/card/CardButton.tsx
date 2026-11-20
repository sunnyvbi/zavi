import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { cardButton } from "./styles";

export type CardButtonVariant = "primary" | "secondary" | "ghost";

export function CardButton({ variant = "secondary", className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: CardButtonVariant }) {
  return <button type={type} className={cn(cardButton.base, cardButton[variant], className)} {...rest} />;
}
