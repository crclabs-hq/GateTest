/**
 * Cross-sell card for the three sibling products in Craig's platform family.
 * Shown on new-user / empty-state surfaces — friendly, short, outbound links
 * only. No shared auth.
 */
export default function SiblingProducts() {
  return (
    <div className="card p-6 text-left">
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex h-2 w-2 rounded-full bg-accent" />
        <p className="text-xs font-mono uppercase tracking-wider text-accent">
          From the same toolbox
        </p>
      </div>
      <h3 className="text-lg font-bold mb-2">
        GateTest pairs well with Vapron and Gluecron
      </h3>
      <p className="text-sm text-muted mb-5">
        GateTest keeps your code honest. Vapron runs your scheduled jobs.
        Gluecron hosts your git. Three small tools, one loose family — use
        whichever you need.
      </p>

      <div className="grid sm:grid-cols-2 gap-3">
        <a
          href="https://vapron.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="group rounded-xl border border-border hover:border-accent/50 bg-white p-4 transition-colors"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-bold text-foreground">Vapron</span>
            <span className="text-xs text-muted group-hover:text-accent transition-colors">
              vapron.ai &rarr;
            </span>
          </div>
          <p className="text-xs text-muted">
            Scheduled jobs that actually run. Cron with receipts.
          </p>
        </a>

        <a
          href="https://gluecron.com"
          target="_blank"
          rel="noopener noreferrer"
          className="group rounded-xl border border-border hover:border-accent/50 bg-white p-4 transition-colors"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-bold text-foreground">Gluecron</span>
            <span className="text-xs text-muted group-hover:text-accent transition-colors">
              gluecron.com &rarr;
            </span>
          </div>
          <p className="text-xs text-muted">
            Git hosting built for small teams. No tickets, no politics.
          </p>
        </a>
      </div>
    </div>
  );
}
