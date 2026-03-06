import { forwardRef, ButtonHTMLAttributes } from "react";

type Variant = "primary" | "danger" | "secondary" | "ghost";
type Size = "default" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-accent hover:bg-accent-hover text-white",
  danger:
    "bg-text-red/15 hover:bg-text-red/25 text-text-red border border-text-red/30",
  secondary:
    "bg-bg-card hover:bg-bg-hover text-text-secondary border border-border hover:border-border-hover",
  ghost:
    "bg-transparent hover:bg-bg-hover text-text-muted hover:text-text-primary",
};

const sizeClasses: Record<Size, string> = {
  default: "px-3.5 py-1.5 text-[13px]",
  sm: "px-2.5 py-1 text-[12px]",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "default", loading, className = "", children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={`relative inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all duration-150 cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
        </span>
      )}
      <span className={loading ? "invisible" : ""}>{children}</span>
    </button>
  )
);

Button.displayName = "Button";
export default Button;
