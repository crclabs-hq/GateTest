/**
 * Homepage composition — Linear/Stripe/Vercel B2B aesthetic.
 *
 * Section order:
 *   1. Navbar
 *   2. Hero           — new headline + dual-track CTA (website scan / repo scan)
 *   3. SimulationMatrix — animated 3-panel pipeline demo (intercept→hypotheses→gate)
 *   4. ModuleRegistry   — 102-module fleet grid organized by technical group
 *   5. Pricing          — 4 tiers + Continuous callout
 *   6. HomeFaq          — HN-skeptic FAQ
 *   7. Footer
 *
 * Dropped from this composition (components kept, not deleted):
 *   HomeKills, HomeFlywheel, HomeSelfScan, HomeCode, HomeTrust
 * The new SimulationMatrix + ModuleRegistry carry the same arguments in a
 * denser, more enterprise-legible form.
 */

import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import SimulationMatrix from "./components/SimulationMatrix";
import ModuleRegistry from "./components/ModuleRegistry";
import Pricing from "./components/Pricing";
import HomeFaq from "./components/HomeFaq";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <SimulationMatrix />
        <ModuleRegistry />
        <Pricing />
        <HomeFaq />
      </main>
      <Footer />
    </>
  );
}
