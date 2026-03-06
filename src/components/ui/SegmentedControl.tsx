interface Option<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "default" | "sm";
}

export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "default",
}: SegmentedControlProps<T>) {
  return (
    <div className="inline-flex bg-bg-elevated border border-border rounded-lg p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`cursor-pointer rounded-md font-medium transition-all duration-150 ${
            size === "sm"
              ? "px-2.5 py-1 text-[11px]"
              : "px-3 py-1.5 text-[12px]"
          } ${
            value === opt.value
              ? "bg-accent text-white shadow-sm"
              : "text-text-muted hover:text-text-primary"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
