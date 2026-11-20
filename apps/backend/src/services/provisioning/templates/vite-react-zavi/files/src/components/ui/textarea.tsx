import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import { fieldClasses } from "./input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 4, ...props },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={cn(fieldClasses, "min-h-[7rem] resize-y", className)} {...props} />;
});
