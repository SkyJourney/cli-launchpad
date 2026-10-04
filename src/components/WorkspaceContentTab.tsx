import { X } from "lucide-react";
import type { DragEvent, MouseEvent, ReactNode } from "react";
import clsx from "clsx";

export function WorkspaceContentTab({
  title,
  active,
  related = false,
  className,
  closeLabel,
  closeAccessibleName,
  draggable = false,
  onDragStart,
  onActivate,
  onRequestClose,
  onContextMenu,
  children,
}: {
  title: string;
  active: boolean;
  related?: boolean;
  className?: string;
  closeLabel: string;
  closeAccessibleName: string;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onActivate: () => void;
  onRequestClose: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div
      className={clsx("pty-pane-tab-group", className, { active })}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        role="tab"
        className={clsx("pty-pane-tab", { active, related })}
        aria-selected={active}
        title={title}
        draggable={draggable}
        onDragStart={onDragStart}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
      >
        {children}
      </button>
      <button
        type="button"
        className="pty-pane-tab-close"
        title={closeLabel}
        aria-label={closeAccessibleName}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRequestClose();
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
