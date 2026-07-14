/**
 * Homepage composition — world-class rebuild for HN / GitHub Marketplace
 * / npm launch.
 *
 * Section order:
 *   1. Navbar
 *   2. Hero  — live URL scan, "One gate. 120 modules. Self-healing CI."
 *   3. HomeKills  — what 12 tools we replace, with flip tiles + full table
 *   4. HomeFlywheel — 4-layer fix flow (AST -> Rule -> Recipe -> Claude)
 *   5. HomeEyesEarsHands — MCP tools: screenshots, production errors, fix verification
 *   6. HomeSelfScan — "GREEN" trust badge with module list
 *   6. HomeCode — install snippets (npx, GitHub Action, CLI cheat-sheet)
 *   7. HomeProof — ROI vs the fragmented stack, real-scan proof, staying-power
 *   8. Pricing — 4 tiers + Continuous subscription card
 *   8b. PentestComingSoon — Live Security Scan waitlist (email capture)
 *   8. HomeFaq — HN-skeptic FAQ
 *   9. HomeStack — full-weight Gluecron + Vapron stack marketing
 *  10. HomeTrust — frameworks scanned + Vapron/Gluecron
 *  11. Footer
 *
 * Sections retained from the previous homepage are intentionally dropped:
 *   - Problem / AiNative / HowItWorks / Modules / Install / Comparison /
 *     Integrations / ContinuousScanning / GateRules / Cta
 * The new homepage carries the same arguments in tighter, denser, more
 * code-forward form — Hacker News bar. The dropped components are not
 * deleted (other pages may reference them).
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
