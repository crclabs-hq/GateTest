/**
 * Homepage — Vercel/Linear quality redesign.
 *
 * Section order: Nav → Hero → Features → Pricing → Footer
 *
 * Previous sections (HomeKills, HomeFlywheel, HomeSelfScan, HomeCode,
 * HomeFaq, HomeStack, HomeTrust, BeforeAfterDemo) are retained on disk
 * for potential use on dedicated landing pages but removed from the
 * main homepage to achieve a tighter, more focused composition.
 */

import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import HomeFeatures from "./components/HomeFeatures";
import Pricing from "./components/Pricing";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <HomeFeatures />
        <Pricing />
      </main>
      <Footer />
    </>
  );
}
