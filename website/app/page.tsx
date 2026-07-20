/**
 * Homepage composition — world-class rebuild for HN / GitHub Marketplace
 * / npm launch.
 *
 * Section order:
 *   1. Navbar
 *   2. Hero  — live URL scan, "One gate. 120 modules. Self-healing CI."
 *   3. HomeKills  — what we replace (flip tiles) + head-to-head capability matrix
 *   4. HomeModuleBreakdown — "what the 120 modules actually check" (#modules)
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

import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
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
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <BeforeAfterDemo />
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
        <HomeStack />
        <HomeTrust />
      </main>
      <Footer />
    </>
  );
}
