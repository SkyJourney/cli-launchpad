import { Search, X } from "lucide-react";
import clsx from "clsx";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  maxLength?: number;
  onClear?: () => void;
  clearLabel?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
  maxLength,
  onClear,
  clearLabel,
}: SearchInputProps) {
  return (
    <div
      className={clsx("project-navigation-search", className, {
        "search-input-with-clear": onClear && value,
      })}
      role="search"
    >
      <Search size={14} aria-hidden="true" />
      <input
        type="text"
        autoComplete="off"
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      {onClear && value && (
        <button
          type="button"
          className="search-input-clear"
          title={clearLabel ?? ariaLabel}
          aria-label={clearLabel ?? ariaLabel}
          onClick={onClear}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
