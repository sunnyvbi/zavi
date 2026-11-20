import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const fieldClasses =
  "w-full min-w-0 rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger sm:text-sm";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldClasses, "h-11", className)} {...props} />;
});
