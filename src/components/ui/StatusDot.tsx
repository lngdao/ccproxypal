export default function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
        active
          ? "bg-text-green animate-pulse-glow"
          : "bg-text-red"
      }`}
    />
  );
}

export function StatusBadge({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${
        active ? "text-text-green" : "text-text-muted"
      }`}
    >
      <StatusDot active={active} />
      {label}
    </span>
  );
}
