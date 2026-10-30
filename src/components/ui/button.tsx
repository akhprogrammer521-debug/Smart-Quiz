import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "default" | "sm" | "icon";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-primary text-white hover:bg-primary-hover",
  secondary: "border-border bg-white text-foreground hover:border-primary/40 hover:bg-[#FFF8EE]",
  ghost: "border-transparent bg-transparent text-foreground hover:bg-[#FFF4E5]",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-12 px-5 text-sm",
  sm: "h-10 px-4 text-sm",
  icon: "size-10 p-0",
};

export function buttonStyles({
  variant = "primary",
  size = "default",
  className,
}: Pick<ButtonProps, "variant" | "size" | "className"> = {}) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-xl border font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25 disabled:pointer-events-none disabled:opacity-50",
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonStyles({ variant, size, className })}
      {...props}
    />
  );
}
