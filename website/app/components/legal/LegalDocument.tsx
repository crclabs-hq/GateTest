import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared renderer for every legal / policy document.
 *
 * Documents are DATA (see `app/legal/_facts.ts` and the `*-content.ts`
 * modules) rendered by this one component, so every page gets the same
 * chrome, anchor ids on every heading (deep-linkable, TOC-able), an
 * "Effective / Last updated" line, and a cross-document footer — and no
 * page needs to exceed the 300-line file cap.
 */

export type LegalBlock =
  | { p: string }
  | { h3: string }
  | { list: string[] }
  | { table: { headers: string[]; rows: string[][] } };

export interface LegalSection {
  id: string;
  heading: string;
  body: LegalBlock[];
}

export interface LegalDoc {
  title: string;
  intro?: string;
  effective: string; // ISO date
  updated?: string; // ISO date
  sections: LegalSection[];
}

export const LEGAL_NAV: { href: string; label: string }[] = [
  { href: "/legal/terms", label: "Terms of Service" },
  { href: "/legal/privacy", label: "Privacy Policy" },
  { href: "/legal/dpa", label: "Data Processing Addendum" },
  { href: "/legal/sub-processors", label: "Sub-processors" },
  { href: "/legal/cookies", label: "Cookie Policy" },
  { href: "/legal/acceptable-use", label: "Acceptable Use" },
  { href: "/legal/refunds", label: "Refund Policy" },
  { href: "/trust", label: "Security & Trust" },
];

const LINK = "text-accent-light hover:underline";

/** Minimal inline markup: **bold**, `code`, [text](href). No HTML. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={k++} className="text-foreground">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      out.push(<code key={k++} className="text-xs bg-white/5 px-1 rounded">{tok.slice(1, -1)}</code>);
    } else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const label = lm ? lm[1] : tok;
      const href = lm ? lm[2] : "#";
      out.push(
        href.startsWith("/") || href.startsWith("#") ? (
          <Link key={k++} href={href} className={LINK}>{label}</Link>
        ) : (
          <a key={k++} href={href} className={LINK} rel="noopener noreferrer">{label}</a>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function fmt(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function Block({ b }: { b: LegalBlock }) {
  if ("p" in b) return <p className="mt-2 first:mt-0">{inline(b.p)}</p>;
  if ("h3" in b) return <h3 className="mt-4 font-semibold text-foreground">{inline(b.h3)}</h3>;
  if ("list" in b) {
    return (
      <ul className="mt-2 list-disc pl-5 space-y-1">
        {b.list.map((li, i) => <li key={i}>{inline(li)}</li>)}
      </ul>
    );
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            {b.table.headers.map((h, i) => (
              <th key={i} className="text-left font-semibold text-foreground border-b border-white/10 py-2 pr-3">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.table.rows.map((r, i) => (
            <tr key={i} className="border-b border-white/5 align-top">
              {r.map((c, j) => <td key={j} className="py-2 pr-3">{inline(c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LegalDocument({ doc, current }: { doc: LegalDoc; current: string }) {
  return (
    <div className="min-h-screen grid-bg px-6 py-24">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">{doc.title}</h1>
        <p className="text-sm text-muted mb-1">Effective date: {fmt(doc.effective)}</p>
        {doc.updated && doc.updated !== doc.effective && (
          <p className="text-sm text-muted mb-1">Last updated: {fmt(doc.updated)}</p>
        )}
        {doc.intro && <p className="text-sm text-muted mt-4 mb-6 leading-relaxed">{inline(doc.intro)}</p>}

        <nav aria-label="Contents" className="mb-8 border border-white/10 rounded p-4 text-xs">
          <p className="font-semibold text-foreground mb-2">Contents</p>
          <ol className="columns-1 sm:columns-2 gap-x-6 space-y-1 list-decimal pl-5 text-muted">
            {doc.sections.map((s) => (
              <li key={s.id}><a href={`#${s.id}`} className="hover:text-foreground">{s.heading}</a></li>
            ))}
          </ol>
        </nav>

        <div className="space-y-8 text-sm text-muted leading-relaxed">
          {doc.sections.map((s, i) => (
            <section key={s.id} id={s.id} className="scroll-mt-24">
              <h2 className="text-lg font-semibold text-foreground mb-2">
                <a href={`#${s.id}`} className="hover:underline">{i + 1}. {s.heading}</a>
              </h2>
              {s.body.map((b, j) => <Block key={j} b={b} />)}
            </section>
          ))}
        </div>

        <nav aria-label="Legal documents" className="mt-12 pt-6 border-t border-white/10 text-xs text-muted">
          <p className="mb-2">Related policies</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {LEGAL_NAV.filter((n) => n.href !== current).map((n) => (
              <li key={n.href}><Link href={n.href} className={LINK}>{n.label}</Link></li>
            ))}
          </ul>
          <p className="mt-6">
            <Link href="/" className="hover:text-foreground transition-colors">&larr; Back to home</Link>
          </p>
        </nav>
      </div>
    </div>
  );
}
