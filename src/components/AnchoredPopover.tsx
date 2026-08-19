import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type PopoverPlacement = "top" | "bottom";

interface PopoverPosition {
  bottom?: number;
  left: number;
  maxHeight: number;
  placement: PopoverPlacement;
  top?: number;
  width: number;
  arrowLeft: number;
}

interface AnchoredPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  dismissible?: boolean;
  footer?: ReactNode;
  header?: ReactNode;
  onClose: () => void;
  preferredWidth?: number;
}

const VIEWPORT_MARGIN = 12;
const POPOVER_GAP = 8;
const POPOVER_WIDTH = 420;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function AnchoredPopover({
  anchorRef,
  ariaLabel,
  children,
  className,
  dismissible = true,
  footer,
  header,
  onClose,
  preferredWidth = POPOVER_WIDTH,
}: AnchoredPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }

      const anchorRect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(
        preferredWidth,
        Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2),
      );
      const left = clamp(
        anchorRect.left,
        VIEWPORT_MARGIN,
        Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
      );
      const spaceBelow = Math.max(
        0,
        viewportHeight - anchorRect.bottom - POPOVER_GAP - VIEWPORT_MARGIN,
      );
      const spaceAbove = Math.max(
        0,
        anchorRect.top - POPOVER_GAP - VIEWPORT_MARGIN,
      );
      const placement: PopoverPlacement =
        spaceBelow >= 280 || spaceBelow >= spaceAbove ? "bottom" : "top";
      const maxHeight = placement === "bottom" ? spaceBelow : spaceAbove;
      const arrowLeft = clamp(
        anchorRect.left + anchorRect.width / 2 - left - 5,
        16,
        Math.max(16, width - 26),
      );

      setPosition({
        bottom:
          placement === "top"
            ? viewportHeight - anchorRect.top + POPOVER_GAP
            : undefined,
        left,
        maxHeight,
        placement,
        top:
          placement === "bottom" ? anchorRect.bottom + POPOVER_GAP : undefined,
        width,
        arrowLeft,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const resizeObserver = new ResizeObserver(updatePosition);
    if (anchorRef.current) {
      resizeObserver.observe(anchorRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, preferredWidth]);

  useEffect(() => {
    if (!dismissible) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !anchorRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [anchorRef, dismissible, onClose]);

  const style = {
    bottom: position?.bottom,
    left: position?.left ?? 0,
    maxHeight: position?.maxHeight,
    top: position?.top,
    visibility: position ? "visible" : "hidden",
    width: position?.width,
    "--popover-arrow-left": `${position?.arrowLeft ?? 16}px`,
  } as CSSProperties;

  return createPortal(
    <div
      ref={popoverRef}
      className={`anchored-popover anchored-popover-${position?.placement ?? "bottom"}${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-label={ariaLabel}
      style={style}
    >
      {header && <div className="anchored-popover-header">{header}</div>}
      <div className="anchored-popover-body">{children}</div>
      {footer && <div className="anchored-popover-footer">{footer}</div>}
    </div>,
    document.body,
  );
}
