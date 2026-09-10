import Link from "next/link";
import StackBar from "./StackBar";

export default function Footer() {
  return (
    <footer className="relative border-t border-border py-12 px-6 bg-background-warm">
      <div className="footer-accent-bar absolute top-0 left-0 right-0" aria-hidden="true" />
      <div className="mx-auto max-w-6xl">
        <StackBar currentProduct="GateTest" />
        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-5 gap-10 mb-12">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-6 h-6 rounded bg-accent flex items-center justify-center">
                <span className="text-white font-bold text-xs font-[var(--font-mono)]">G</span>
              </div>
              <span className="font-bold">
                Gate<span className="gradient-text">Test</span>
              </span>
            </div>
            <p className="text-sm text-muted leading-relaxed">
              The advanced QA gate between AI and GitHub. Nothing ships unless it&apos;s pristine.
            </p>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-4">Product</h4>
            <ul className="space-y-2">
              {/* Real routes, not homepage anchors — /modules, /pricing and
                  /enterprise are pages in their own right. /#features has no
                  page of its own, so it stays an anchor. */}
              <li><Link href="/#features" className="text-sm text-muted hover:text-foreground transition-colors">Features</Link></li>
              <li><Link href="/modules" className="text-sm text-muted hover:text-foreground transition-colors">Modules</Link></li>
              <li><Link href="/pricing" className="text-sm text-muted hover:text-foreground transition-colors">Pricing</Link></li>
              <li><Link href="/enterprise" className="text-sm text-muted hover:text-foreground transition-colors">Enterprise</Link></li>
              <li><Link href="/precision" className="text-sm text-muted hover:text-foreground transition-colors">Precision benchmark</Link></li>
              <li><Link href="/changelog" className="text-sm text-muted hover:text-foreground transition-colors">Changelog</Link></li>
              <li><Link href="/noise" className="text-sm text-muted hover:text-foreground transition-colors">Rule noise</Link></li>
              <li><Link href="/web" className="text-sm text-muted hover:text-foreground transition-colors">Website Scanner</Link></li>
              <li><Link href="/wp" className="text-sm text-muted hover:text-foreground transition-colors">WordPress Scanner</Link></li>
              <li><Link href="/billing" className="text-sm text-muted hover:text-foreground transition-colors">Manage Subscription</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-4">Learn</h4>
            <ul className="space-y-2">
              <li><Link href="/glossary" className="text-sm text-muted hover:text-foreground transition-colors">Glossary</Link></li>
              <li><Link href="/use-cases" className="text-sm text-muted hover:text-foreground transition-colors">Use cases</Link></li>
              <li><Link href="/blog" className="text-sm text-muted hover:text-foreground transition-colors">Blog</Link></li>
              <li><Link href="/compare" className="text-sm text-muted hover:text-foreground transition-colors">Comparisons</Link></li>
              <li><Link href="/find" className="text-sm text-muted hover:text-foreground transition-colors">CWE Top 25</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-4">Resources</h4>
            <ul className="space-y-2">
              <li><a href="https://github.com/crclabs-hq/GateTest#readme" target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">Documentation</a></li>
              <li><a href="https://github.com/crclabs-hq/GateTest" target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">GitHub</a></li>
              <li><a href="https://github.com/crclabs-hq/GateTest/releases" target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">Changelog</a></li>
              <li><a href="https://github.com/crclabs-hq/GateTest/issues" target="_blank" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">Report Issue</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-4">Ecosystem</h4>
            <ul className="space-y-2">
              <li><a href="https://gluecron.com" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">Gluecron — git hosting, gate built in</a></li>
              <li><a href="https://vapron.ai" rel="noopener noreferrer" className="text-sm text-muted hover:text-foreground transition-colors">Vapron — the platform that runs it</a></li>
              <li><Link href="/stack" className="text-sm text-muted hover:text-foreground transition-colors">How the stack fits together</Link></li>
              <li><Link href="/github/setup" className="text-sm text-muted hover:text-foreground transition-colors">GitHub App</Link></li>
              <li><Link href="/wp" className="text-sm text-muted hover:text-foreground transition-colors">WordPress</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-4">Company</h4>
            <ul className="space-y-2">
              <li><Link href="/#features" className="text-sm text-muted hover:text-foreground transition-colors">About</Link></li>
              <li><Link href="/trust" className="text-sm text-muted hover:text-foreground transition-colors">Trust &amp; Security</Link></li>
              <li><a href="mailto:hello@gatetest.ai" className="text-sm text-muted hover:text-foreground transition-colors">Contact</a></li>
              <li><Link href="/legal/privacy" className="text-sm text-muted hover:text-foreground transition-colors">Privacy Policy</Link></li>
              <li><Link href="/legal/terms" className="text-sm text-muted hover:text-foreground transition-colors">Terms of Service</Link></li>
              <li><Link href="/legal/dpa" className="text-sm text-muted hover:text-foreground transition-colors">Data Processing Addendum</Link></li>
              <li><Link href="/legal/sub-processors" className="text-sm text-muted hover:text-foreground transition-colors">Sub-processors</Link></li>
              <li><Link href="/legal/cookies" className="text-sm text-muted hover:text-foreground transition-colors">Cookie Policy</Link></li>
              <li><Link href="/legal/refunds" className="text-sm text-muted hover:text-foreground transition-colors">Refund Policy</Link></li>
              <li><Link href="/legal/acceptable-use" className="text-sm text-muted hover:text-foreground transition-colors">Acceptable Use</Link></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-border/30 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted">
            &copy; {new Date().getFullYear()} GateTest. All rights reserved.
          </p>
          <p className="text-xs text-muted">
            AI writes fast. GateTest keeps it honest.
          </p>
        </div>
      </div>
    </footer>
  );
}
