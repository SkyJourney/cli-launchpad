import { ChevronRight } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SplitDirection } from "../lib/ptyWorkspaceLayout";

export interface WorkspaceContextMenuPane {
  id: string;
  title: string;
}

export interface WorkspaceContentMenuLabels {
  menu: string;
  closeCurrent: (title: string) => string;
  closeOthers: (count: number) => string;
  closeAll: (count: number) => string;
  splitAndMoveRight: string;
  splitAndMoveDown: string;
}

export function WorkspaceContentContextMenu({
  title,
  x,
  y,
  otherPanes,
  labels,
  allowDetach,
  otherContentCount,
  paneContentCount,
  onClose,
  onSplit,
  onSplitAndMove,
  onMoveToPane,
  onDetach,
  onCloseCurrent,
  onCloseOthers,
  onCloseAll,
}: {
  title: string;
  x: number;
  y: number;
  otherPanes: WorkspaceContextMenuPane[];
  labels: WorkspaceContentMenuLabels;
  allowDetach: boolean;
  otherContentCount: number;
  paneContentCount: number;
  onClose: () => void;
  onSplit: (direction: SplitDirection) => void;
  onSplitAndMove: (direction: SplitDirection) => void;
  onMoveToPane: (paneId: string) => void;
  onDetach: () => void;
  onCloseCurrent: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);
  const [position, setPosition] = useState({ left: x, top: y });
  const [submenuPosition, setSubmenuPosition] = useState({ left: 8, top: 8 });
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    });
  }, [moveSubmenuOpen, x, y]);

  useLayoutEffect(() => {
    if (!moveSubmenuOpen) return;
    const anchor = moveButtonRef.current;
    const submenu = submenuRef.current;
    if (!anchor || !submenu) return;
    const anchorBounds = anchor.getBoundingClientRect();
    const submenuBounds = submenu.getBoundingClientRect();
    const gap = 4;
    const padding = 8;
    const placeRight =
      window.innerWidth - anchorBounds.right >=
      submenuBounds.width + gap + padding;
    setSubmenuPosition({
      left: placeRight
        ? anchorBounds.right + gap
        : Math.max(padding, anchorBounds.left - submenuBounds.width - gap),
      top: Math.max(
        padding,
        Math.min(
          anchorBounds.top - 5,
          window.innerHeight - submenuBounds.height - padding,
        ),
      ),
    });
    submenu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [moveSubmenuOpen]);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape, true);
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowLeft" && moveSubmenuOpen) {
      event.preventDefault();
      setMoveSubmenuOpen(false);
      moveButtonRef.current?.focus();
      return;
    }
    if (
      event.key === "ArrowRight" &&
      event.target === moveButtonRef.current &&
      otherPanes.length > 0
    ) {
      event.preventDefault();
      setMoveSubmenuOpen(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    ).filter((item) => item.getClientRects().length > 0);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[nextIndex].focus();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="pty-session-context-menu"
      role="menu"
      aria-label={labels.menu}
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onSplit("horizontal")}
      >
        {t("pty.splitRight")}
      </button>
      <button type="button" role="menuitem" onClick={() => onSplit("vertical")}>
        {t("pty.splitDown")}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onSplitAndMove("horizontal")}
      >
        {labels.splitAndMoveRight}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onSplitAndMove("vertical")}
      >
        {labels.splitAndMoveDown}
      </button>
      <div className="pty-session-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        disabled={!allowDetach}
        onClick={onDetach}
      >
        {t("pty.openSeparateWindow")}
      </button>
      <div className="pty-session-menu-submenu">
        <button
          ref={moveButtonRef}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={moveSubmenuOpen}
          disabled={otherPanes.length === 0}
          onClick={() => setMoveSubmenuOpen((open) => !open)}
        >
          <span>{t("pty.moveToPane")}</span>
          <ChevronRight size={14} />
        </button>
        {moveSubmenuOpen && otherPanes.length > 0 && (
          <div
            ref={submenuRef}
            className="pty-session-submenu-items"
            role="menu"
            aria-label={t("pty.moveToPane")}
            style={{ left: submenuPosition.left, top: submenuPosition.top }}
          >
            {otherPanes.map((pane) => (
              <button
                key={pane.id}
                type="button"
                role="menuitem"
                onClick={() => onMoveToPane(pane.id)}
              >
                {pane.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pty-session-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={onCloseCurrent}
      >
        {labels.closeCurrent(title)}
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        disabled={otherContentCount === 0}
        onClick={onCloseOthers}
      >
        {labels.closeOthers(otherContentCount)}
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        disabled={paneContentCount === 0}
        onClick={onCloseAll}
      >
        {labels.closeAll(paneContentCount)}
      </button>
    </div>,
    document.body,
  );
}
