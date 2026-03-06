import { InputHTMLAttributes, forwardRef, ReactNode } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, className = "", ...props }, ref) => (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-[12px] font-medium text-text-secondary">
          {label}
        </label>
      )}
      <input
        ref={ref}
        className={`w-full bg-bg-elevated border border-border rounded-md px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted/60 outline-none focus:border-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
        {...props}
      />
      {hint && (
        <p className="text-[11px] text-text-muted leading-relaxed">{hint}</p>
      )}
    </div>
  )
);

Input.displayName = "Input";
export default Input;

interface TextAreaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: ReactNode;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, hint, className = "", ...props }, ref) => (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-[12px] font-medium text-text-secondary">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        className={`w-full bg-bg-elevated border border-border rounded-md px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted/60 outline-none focus:border-accent transition-colors resize-none disabled:opacity-50 disabled:cursor-not-allowed font-mono ${className}`}
        {...props}
      />
      {hint && (
        <p className="text-[11px] text-text-muted leading-relaxed">{hint}</p>
      )}
    </div>
  )
);

TextArea.displayName = "TextArea";
