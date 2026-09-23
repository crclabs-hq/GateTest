/**
 * Homepage composition — world-class rebuild for HN / GitHub Marketplace
 * / npm launch.
 *
 * Section order:
 *   1. Navbar
 *   2. Hero  — live URL scan, "One gate. 121 modules. Self-healing CI."
 *   2b. HomeThreeDoors — repo / website / AI-agent entry points (Craig
 *       2026-08-06: the page sold one story that needed a repo, a CI, a
 *       GitHub install and a developer, while live web auditing, the
 *       WordPress suite and the free local MCP server were reachable only
 *       by scrolling)
 *   3. HomeKills  — what we replace (flip tiles) + head-to-head capability matrix
 *   4. HomeModuleBreakdown — "what the 121 modules actually check" (#modules)
 *   5. HomeFlywheel — 4-layer fix flow (AST -> Rule -> Recipe -> AI) + prove-it
 *   6. HomeEyesEarsHands — MCP tools: eyes/ears/hands hook + plain explanations
 *   7. HomeSelfScan — "GREEN" trust badge with module list
 *   8. HomeCode — install snippets (npx, GitHub Action, CLI cheat-sheet)
 *   9. HomeProof — ROI vs the fragmented stack, real-scan proof, staying-power
 *  10. Pricing — 4 tiers + Continuous subscription card
 *  10b. AfterFree — what a free scan keeps, what a paid run adds, what
 *       happens at the 48h share-link limit (issue #678 gap 5)
 *  11. PentestComingSoon — Live Security Scan waitlist (email capture)
 *  12. HomeFaq — HN-skeptic FAQ
 *  13. HomeStack — full-weight Gluecron + Tallrig stack marketing
 *  15. HomeTrust — frameworks scanned + Tallrig/Gluecron
 *  16. Footer
 *
 * Sections retained from the previous homepage are intentionally dropped:
 *   - Problem / AiNative / HowItWorks / Modules / Install / Comparison /
 *     Integrations / GateRules / Cta
 * The new homepage carries the same arguments in tighter, denser, more
 * code-forward form — Hacker News bar. The dropped components are not
 * deleted (other pages may reference them). ContinuousScanning.tsx WAS
 * deleted (2026-07-20 security audit) — it was truly unreferenced
 * anywhere and its "Full automated penetration testing against staging"
 * bullet contradicted the live, correct PentestComingSoon ("coming soon")
 * component.
 */

import Hero from "./components/Hero";
import HomePrecision from "./components/HomePrecision";
import HomeHonest from "./components/HomeHonest";
import HomeThreeDoors from "./components/HomeThreeDoors";
import BeforeAfterDemo from "./components/BeforeAfterDemo";
import HomeSelfScan from "./components/HomeSelfScan";
import HomeCode from "./components/HomeCode";
import Pricing from "./components/Pricing";
import AfterFree from "./components/AfterFree";
import PentestComingSoon from "./components/PentestComingSoon";
import HomeFaq from "./components/HomeFaq";
import HomeStack from "./components/HomeStack";
import HomeEverywhere from "./components/HomeEverywhere";
import HomeTrust from "./components/HomeTrust";

// The homepage owns its own canonical. It used to live on the ROOT layout
// (`alternates.canonical: "/"`), which every page without its own metadata
// inherited — 20+ pages told search engines their canonical URL was the
// homepage (2026-08-18 audit).
export const metadata = { alternates: { canonical: "/" } };

export default function Home() {
  return (
    <>
      <main>
        <Hero />
        <HomePrecision />
        <HomeThreeDoors />
        {/* The stack sits high on purpose (Craig 2026-09-10): the site's job is
            to lead GitHub, website and WordPress visitors toward Gluecron and
            Tallrig, not to mention them after the FAQ. */}
        <HomeStack />
        <HomeEverywhere />
        <BeforeAfterDemo />
        <HomeHonest />
        <HomeSelfScan />
        <HomeCode />
        <Pricing />
        <AfterFree />
        <PentestComingSoon />
        <HomeFaq />
        <HomeTrust />
      </main>
    </>
  );
}
