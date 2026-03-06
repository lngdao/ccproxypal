import { ReactNode } from "react";

interface InfoRowProps {
  label: string;
  children: ReactNode;
}

export default function InfoRow({ label, children }: InfoRowProps) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[12px] text-text-muted min-w-[100px] shrink-0">
        {label}
      </span>
      <span className="text-[13px] text-text-primary text-right">
        {children}
      </span>
    </div>
  );
}
