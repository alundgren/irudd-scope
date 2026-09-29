import { useId } from "react";

export function Switch({
  label,
  checked,
  disabled,
  describedBy,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  describedBy?: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="setting-switch">
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      <div className="setting-switch-control">
        <span className="setting-switch-state" aria-hidden="true">
          {checked ? "On" : "Off"}
        </span>
        <button
          id={id}
          type="button"
          className="setting-switch-button"
          role="switch"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onCheckedChange(!checked)}
        >
          <span className="setting-switch-thumb" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
