import { Check, ChevronDown } from "lucide-react";
import { useRef } from "react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import * as Select from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export function SelectField({
  label,
  value,
  placeholder,
  options,
  disabled = false,
  quiet = false,
  onValueChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly placeholder: string;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  readonly quiet?: boolean;
  readonly onValueChange: (value: string) => void;
}) {
  const pointerOpened = useRef(false);
  return (
    <div className={`select-field${quiet ? " quiet" : ""}`}>
      <span className={quiet ? "sr-only" : "select-field-label"}>{label}</span>
      <Select.Root value={value ?? undefined} disabled={disabled} onValueChange={onValueChange}>
        <Select.Trigger
          className="select-trigger"
          aria-label={label}
          onPointerDown={() => {
            pointerOpened.current = true;
          }}
          onKeyDown={() => {
            pointerOpened.current = false;
          }}
        >
          <Select.Value placeholder={placeholder} />
          <Select.Icon className="select-trigger-icon">
            <ChevronDown aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="select-content"
            position="popper"
            sideOffset={5}
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              if (!pointerOpened.current) return;
              event.preventDefault();
              pointerOpened.current = false;
            }}
          >
            <Select.Viewport className="select-viewport">
              {options.map((option) => (
                <Select.Item className="select-item" key={option.value} value={option.value}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="select-item-indicator">
                    <Check aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

export function SectionHeader({
  title,
  className = "detail-section-head",
  children,
}: {
  readonly title: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={className}>
      <p className="section-label">{title.toUpperCase()}</p>
      {children}
    </div>
  );
}

export function Hint({
  label,
  children,
  side = "bottom",
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip.Root delayDuration={250}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ui-tooltip" side={side} sideOffset={7}>
          {label}
          <Tooltip.Arrow className="ui-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function IconButton({
  icon: Icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  readonly icon: IconComponent;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        className={`icon-button${active ? " active" : ""}`}
        aria-label={label}
        aria-pressed={active}
        aria-disabled={disabled}
        onClick={() => !disabled && onClick()}
      >
        <Icon aria-hidden="true" />
      </button>
    </Hint>
  );
}
