"use client";

/**
 * Admin UI kit — the shared, accessible, token-styled primitives the admin
 * console is built from. Replaces the ad-hoc per-tab markup (inconsistent
 * gray/emerald buttons, cards, inputs, and non-accessible tab buttons) with
 * one consistent vocabulary that matches the site's teal design system
 * (var(--accent) etc.).
 *
 * Everything here is presentational + accessible: real focus rings, proper
 * <label> association, role="tab"/aria-selected on the tab bar with arrow-key
 * navigation, and a toast system for success/error feedback.
 */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
export function AdminCard({
  children,
  className = "",
  accent,
}: {
  children: ReactNode;
  className?: string;
  accent?: "warning" | "danger" | "accent";
}) {
  const leftBorder =
    accent === "warning"
      ? "border-l-4 border-l-[var(--warning)]"
      : accent === "danger"
        ? "border-l-4 border-l-[var(--danger)]"
        : accent === "accent"
          ? "border-l-4 border-l-[var(--accent)]"
          : "";
  return (
    <div
      className={`rounded-[var(--radius-lg)] bg-[var(--surface-solid)] border border-[var(--border)] shadow-[var(--shadow-sm)] ${leftBorder} ${className}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------
export function StatCard({ label, value, tone }: { label: string; value: ReactNode; tone?: "accent" | "danger" }) {
  const color =
    tone === "accent" ? "text-[var(--accent)]" : tone === "danger" ? "text-[var(--danger)]" : "text-[var(--foreground)]";
  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--surface-solid)] border border-[var(--border)] shadow-[var(--shadow-sm)] p-4 text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-[var(--muted)] mt-0.5">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
type BtnVariant = "primary" | "secondary" | "danger";
export function AdminButton({
  children,
  onClick,
  variant = "primary",
  size = "md",
  disabled,
  busy,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: BtnVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] font-semibold transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 disabled:opacity-50 disabled:cursor-not-allowed";
  const sizes = size === "sm" ? "px-3 py-1.5 text-xs" : "px-5 py-2.5 text-sm";
  const variants: Record<BtnVariant, string> = {
    primary: "bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white shadow-[var(--shadow-sm)]",
    secondary:
      "bg-[var(--background-alt)] hover:bg-[var(--border)] text-[var(--foreground)] border border-[var(--border)]",
    danger: "bg-[var(--danger)] hover:opacity-90 text-white",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={`${base} ${sizes} ${variants[variant]} ${className}`}
    >
      {busy && (
        <span
          className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin"
          role="status"
          aria-label="loading"
        />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Labeled input + select
// ---------------------------------------------------------------------------
const fieldClasses =
  "w-full px-3.5 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-white text-[var(--foreground)] placeholder:text-[var(--muted)] text-sm focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30 transition";

export function AdminField({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label?: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={htmlFor} className="text-xs font-semibold text-[var(--foreground-secondary)]">
          {label}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-[var(--muted)]">{hint}</p>}
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}

export function AdminInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldClasses} ${props.className || ""}`} />;
}

export function AdminSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${fieldClasses} ${props.className || ""}`} />;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------
export function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone =
    s.includes("complet") || s.includes("pass") || s.includes("ok") || s.includes("green") || s.includes("active")
      ? "bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/30"
      : s.includes("fail") || s.includes("error") || s.includes("block") || s.includes("revok")
        ? "bg-[var(--danger)]/10 text-[var(--danger)] border-[var(--danger)]/30"
        : s.includes("pend") || s.includes("run") || s.includes("scan")
          ? "bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/30"
          : "bg-[var(--background-alt)] text-[var(--muted)] border-[var(--border)]";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${tone}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Accessible tabs
// ---------------------------------------------------------------------------
export interface TabDef {
  id: string;
  label: string;
  danger?: boolean;
}

export function AdminTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKeyDown(e: React.KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === active);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
      onChange(tabs[next].id);
      refs.current[tabs[next].id]?.focus();
    }
  }
  return (
    <div role="tablist" aria-label="Admin sections" onKeyDown={onKeyDown} className="flex gap-1 mb-6 border-b border-[var(--border)] overflow-x-auto">
      {tabs.map((t) => {
        const selected = active === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[t.id] = el; }}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 rounded-t ${
              selected
                ? t.danger
                  ? "border-[var(--danger)] text-[var(--danger)] font-bold"
                  : "border-[var(--accent)] text-[var(--foreground)]"
                : `border-transparent hover:text-[var(--foreground)] ${t.danger ? "text-[var(--danger)]/70" : "text-[var(--muted)]"}`
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast system — success/error feedback (replaces bare red <p> error text)
// ---------------------------------------------------------------------------
interface ToastItem {
  id: number;
  message: string;
  tone: "success" | "error";
}
interface ToastCtx {
  success: (m: string) => void;
  error: (m: string) => void;
}
const ToastContext = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const push = useCallback((message: string, tone: "success" | "error") => {
    const id = ++idRef.current;
    setItems((xs) => [...xs, { id, message, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4500);
  }, []);
  const api: ToastCtx = {
    success: (m) => push(m, "success"),
    error: (m) => push(m, "error"),
  };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={`rounded-[var(--radius-md)] px-4 py-3 text-sm font-medium shadow-[var(--shadow-lg)] border ${
              t.tone === "success"
                ? "bg-white text-[var(--accent)] border-[var(--accent)]/30"
                : "bg-white text-[var(--danger)] border-[var(--danger)]/30"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
