/**
 * The v2 design system's component side — issue #686 phase 1. One import
 * for every page migrating off the pre-2026-09-23 marketing-template look.
 * The CSS side (tokens + the .v2-, .gh- and .term- class families) lives in
 * website/app/globals.css. Import from here, not from individual files, so
 * a page never has to know which file a primitive lives in.
 */
export { Rail, STAGES } from "./Rail";
export { Numbers } from "./Numbers";
export { Faq } from "./Faq";
export { Pricing } from "./Pricing";
export { Artifacts } from "./Artifacts";
export { Section } from "./Section";
export { Card } from "./Card";
export { Terminal } from "./Terminal";
export { Stat } from "./Stat";
export { Callout } from "./Callout";
export { Hero } from "./Hero";
export { IconCheck, IconCross, IconArrowRight, IconChevronDown, IconDot } from "./Icons";
