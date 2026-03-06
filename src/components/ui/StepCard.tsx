import { ReactNode } from "react";

interface StepCardProps {
  step: number;
  title: string;
  completed?: boolean;
  disabled?: boolean;
  headerRight?: ReactNode;
  children: ReactNode;
}

export default function StepCard({
  step,
  title,
  completed,
  disabled,
  headerRight,
  children,
}: StepCardProps) {
  return (
    <div
      className={`bg-bg-card border rounded-lg p-4 transition-all duration-200 ${
        disabled
          ? "border-border/50 opacity-50 pointer-events-none"
          : "border-border"
      }`}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold ${
              completed
                ? "bg-text-green/20 text-text-green"
                : "bg-accent-dim text-accent"
            }`}
          >
            {completed ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2.5 6L5 8.5L9.5 3.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              step
            )}
          </div>
          <span className="text-[13px] font-semibold text-text-primary">
            {title}
          </span>
        </div>
        {headerRight}
      </div>
      <div className="ml-9">{children}</div>
    </div>
  );
}
