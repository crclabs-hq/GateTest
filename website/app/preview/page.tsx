/**
 * GateTest.ai — standalone premium homepage (greenfield prototype).
 *
 * Self-contained to this route: every section, the motion layer, and the icon
 * set live under `app/preview/` (private `_components` / `_lib` folders). No
 * imports from the legacy marketing components, no new dependencies — motion is
 * hand-rolled CSS + IntersectionObserver. Deployed to /preview for review
 * before any live swap.
 *
 * Aesthetic: deep-ink "developer-luxe" — razor-thin borders, glass panels,
 * teal/emerald brand glow, mono code surfaces.
 */

import { NavBar } from "./_components/Nav";
import { Hero } from "./_components/Hero";
import { TrustStrip } from "./_components/TrustStrip";
import { Pipeline } from "./_components/Pipeline";
import { Bento } from "./_components/Bento";
import { Playground } from "./_components/Playground";
import { Enterprise } from "./_components/Enterprise";
import { FinalCTA, Footer } from "./_components/Cta";

export default function PreviewHomepage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden bg-[#06070b] text-zinc-200 antialiased selection:bg-teal-400/20 selection:text-white">
      {/* scoped styles: keyframes + reveal + scroll behaviour */}
      <style>{`
        html { scroll-behavior: smooth; }
        .gt-preview-root { background: #06070b; }
        .gt-reveal {
          opacity: 0;
          transform: translateY(16px);
          transition: opacity 0.6s cubic-bezier(0.16,1,0.3,1),
                      transform 0.6s cubic-bezier(0.16,1,0.3,1);
          will-change: opacity, transform;
        }
        .gt-reveal.gt-in { opacity: 1; transform: translateY(0); }
        @keyframes gtPing {
          0% { transform: scale(1); opacity: 0.7; }
          80%,100% { transform: scale(1.5); opacity: 0; }
        }
        .gt-ping { animation: gtPing 1.8s cubic-bezier(0,0,0.2,1) infinite; }
        @keyframes gtFloat {
          0%,100% { transform: translateY(0) rotateX(0) rotateY(0); }
          50% { transform: translateY(-6px); }
        }
        .gt-tilt { animation: gtFloat 7s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
          .gt-reveal { opacity: 1; transform: none; transition: none; }
          .gt-ping, .gt-tilt { animation: none; }
        }
      `}</style>

      <NavBar />
      <Hero />
      <TrustStrip />
      <Pipeline />
      <Bento />
      <Playground />
      <Enterprise />
      <FinalCTA />
      <Footer />
    </main>
  );
}
