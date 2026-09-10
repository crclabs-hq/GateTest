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
 *   5. HomeFlywheel — 4-layer fix flow (AST -> Rule -> Recipe -> Claude) + prove-it
 *   6. HomeModelChoice — BYOK vs supplied metered; Sonnet 5 / Opus 4.8 / Fable 5
 *   7. HomeEyesEarsHands — MCP tools: eyes/ears/hands hook + plain explanations
 *   8. HomeSelfScan — "GREEN" trust badge with module list
 *   9. HomeCode — install snippets (npx, GitHub Action, CLI cheat-sheet)
 *  10. HomeProof — ROI vs the fragmented stack, real-scan proof, staying-power
 *  11. Pricing — 4 tiers + Continuous subscription card
 *  12. PentestComingSoon — Live Security Scan waitlist (email capture)
 *  13. HomeFaq — HN-skeptic FAQ
 *  14. HomeStack — full-weight Gluecron + Vapron stack marketing
 *  15. HomeTrust — frameworks scanned + Vapron/Gluecron
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
import HomeKills from "./components/HomeKills";
import HomeModuleBreakdown from "./components/HomeModuleBreakdown";
import HomeFlywheel from "./components/HomeFlywheel";
import HomeModelChoice from "./components/HomeModelChoice";
import HomeEyesEarsHands from "./components/HomeEyesEarsHands";
import HomeSelfScan from "./components/HomeSelfScan";
import HomeCode from "./components/HomeCode";
import HomeProof from "./components/HomeProof";
import Pricing from "./components/Pricing";
import PentestComingSoon from "./components/PentestComingSoon";
import HomeFaq from "./components/HomeFaq";
import HomeStack from "./components/HomeStack";
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
            Vapron, not to mention them after the FAQ. */}
        <HomeStack />
        <BeforeAfterDemo />
        <HomeHonest />
        <HomeKills />
        <HomeModuleBreakdown />
        <HomeFlywheel />
        <HomeModelChoice />
        <HomeEyesEarsHands />
        <HomeSelfScan />
        <HomeCode />
        <HomeProof />
        <Pricing />
        <PentestComingSoon />
        <HomeFaq />
        <HomeTrust />
      </main>
    </>
  );
}
