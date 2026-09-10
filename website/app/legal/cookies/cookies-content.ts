import type { LegalDoc } from "../../components/legal/LegalDocument";
import * as F from "../_facts";

const yesNo = (b: boolean) => (b ? "Yes" : "No");
const row = (c: (typeof F.COOKIES)[number]) => [`\`${c.name}\``, c.purpose, c.duration, yesNo(c.essential)];

const BROWSER_COOKIES = F.COOKIES.filter((c) => c.kind === "cookie");
const BROWSER_STORAGE = F.COOKIES.filter((c) => c.kind === "localStorage");

export const DOC: LegalDoc = {
  title: "Cookie Policy",
  intro: `Every cookie and browser-storage key that ${F.siteHost()} sets, what it is for, how long it lasts, and how to control it. There are no advertising or tracking cookies.`,
  effective: F.EFFECTIVE_DATE,
  sections: [
    {
      id: "what-cookies-are",
      heading: "What Cookies Are",
      body: [
        { p: "A cookie is a small text record your browser stores for a website and sends back with each request, which is how a site can tell that the person on the next page is the one who just signed in. Browser storage (localStorage) is similar but stays in the browser and is not sent with requests unless a script sends it." },
        { p: `This page lists all of them for ${F.siteHost()}. It is part of our [Privacy Policy](/legal/privacy).` },
      ],
    },
    {
      id: "cookies-we-set",
      heading: "Cookies We Set",
      body: [
        { p: "Every cookie below is strictly necessary: each one exists only so that you can sign in and stay signed in safely. None is used to identify you across other websites." },
        { table: { headers: ["Name", "Purpose", "Duration", "Essential"], rows: BROWSER_COOKIES.map(row) } },
      ],
    },
    {
      id: "browser-storage",
      heading: "Browser Storage",
      body: [
        { p: "These keys live in your browser's local storage. Neither is required for the service to work." },
        { table: { headers: ["Name", "Purpose", "Duration", "Essential"], rows: BROWSER_STORAGE.map(row) } },
      ],
    },
    {
      id: "no-advertising-or-tracking",
      heading: "No Advertising or Tracking",
      body: [
        { list: [
          "**No advertising networks** — we set no ad or retargeting cookies and load no ad scripts.",
          "**No analytics trackers** — there is no page-view analytics service on the site.",
          "**No cross-site tracking** — nothing we set identifies you on any other website, and we do not sell or share cookie data.",
          "The only third-party storage is the short replay buffer kept by our error-monitoring provider so it can show us what happened just before an error. It is scrubbed of form input, keys and cookies before anything leaves your browser.",
        ] },
        { p: "Because we set only strictly necessary cookies, we do not show a cookie banner. If that ever changes, this page and the banner will change together." },
      ],
    },
    {
      id: "how-to-control",
      heading: "How to Control Cookies",
      body: [
        { list: [
          "**Browser settings** — every major browser lets you block, restrict or delete cookies and site data for a specific site. Look for \"Cookies and site data\" or \"Site settings\" in your browser's privacy settings.",
          `**Signing out** — signing out ends your session. Your session cookie also expires on its own after ${F.SESSION_DAYS} days.`,
          `**Clearing site data** — removes every cookie and storage key listed above at once. You will need to sign in again.`,
          "**What blocking means** — the essential cookies are required to sign in, so with them blocked you can still read the site and run a free scan, but you cannot sign in or buy a scan.",
        ] },
      ],
    },
    {
      id: "changes",
      heading: "Changes",
      body: [
        { p: "The tables on this page are generated from the same list the application itself uses, so a new cookie cannot ship without appearing here. If we ever add a cookie that is not strictly necessary we will ask for your consent before setting it." },
      ],
    },
    {
      id: "contact",
      heading: "Contact",
      body: [
        { p: `Questions about cookies or browser storage: **${F.LEGAL_ENTITY}**, [${F.SUPPORT_EMAIL}](mailto:${F.SUPPORT_EMAIL}).` },
      ],
    },
  ],
};
