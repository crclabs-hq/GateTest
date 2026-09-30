"use client";

/**
 * Modal — a native <dialog> opened with showModal() on mount.
 *
 * showModal() puts the dialog in the top layer and makes the rest of the page
 * inert; the Tab handler below additionally wraps focus inside the dialog so
 * keyboard focus can never leave it, and Esc (the dialog's `cancel` event)
 * calls `onClose` instead of closing behind React's back. Focus returns to
 * whatever had it before the dialog opened. Mount = open, unmount = closed:
 * callers render it conditionally.
 */

import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  labelledBy,
  onClose,
  className,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    const preferred = dialog.querySelector<HTMLElement>("[data-autofocus]");
    const first = preferred ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      previous?.focus();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const dialog = ref.current;
    if (!dialog) return;
    const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={ref}
      className={`gs-dialog${className ? ` ${className}` : ""}`}
      aria-labelledby={labelledBy}
      aria-modal="true"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
