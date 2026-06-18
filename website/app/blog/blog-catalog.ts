/**
 * Blog catalogue for /blog and /blog/[slug].
 *
 * Deep technical posts (BlogPosting schema, og:type=article). Each post is
 * original long-form prose with a clear thesis — the kind of page that earns
 * links and gets cited by AI answer engines, not a thin SEO stub.
 *
 * Source of truth for the /blog URL set.
 */

export interface BlogSection {
  /** Optional H2 heading for the section. */
  heading?: string;
  /** Paragraphs of prose. */
  paragraphs?: string[];
  /** Optional code block. */
  code?: { lang: string; content: string };
  /** Optional bullet list. */
  bullets?: string[];
}

export interface BlogPost {
  slug: string;
  title: string;
  /** Meta description + hero standfirst. */
  description: string;
  /** ISO date. */
  datePublished: string;
  dateModified?: string;
  /** Reading-time label, e.g. "8 min read". */
  readTime: string;
  /** Tag labels. */
  tags: string[];
  /** Body sections. */
  sections: BlogSection[];
  related: string[];
  faqs: { q: string; a: string }[];
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "why-ai-generated-code-needs-a-qa-gate",
    title: "Why AI-Generated Code Needs a QA Gate",
    description:
      "AI writes code faster than any human can review it. That speed is real leverage — and it quietly changes where bugs come from and how fast they accumulate. Here's why an automated gate stops being optional once an agent is committing to your repo.",
    datePublished: "2026-05-28",
    readTime: "8 min read",
    tags: ["AI", "code quality", "quality gate"],
    sections: [
      {
        paragraphs: [
          "A year ago, the bottleneck in shipping software was writing it. Today, for a growing share of teams, the bottleneck is reviewing what an AI agent wrote. Claude Code, Cursor, Copilot, and their peers produce plausible, well-structured, frequently-correct code at a rate no human author matches. The leverage is enormous and it's not going away.",
          "But the shape of the risk changed with it. When a human writes a function, the bug distribution reflects human error: the off-by-one, the forgotten null check, the copy-paste that didn't get fully updated. When a model writes a function, you still get those — plus a new class of failure that comes from the model being confidently, fluently wrong.",
        ],
      },
      {
        heading: "The failure modes are different",
        paragraphs: [
          "AI-generated code fails in ways that look right at a glance, which is exactly what makes them dangerous. The code compiles, the tests the model also wrote pass, the diff reads cleanly — and a real flaw sits underneath.",
        ],
        bullets: [
          "Invented APIs: a method or package that doesn't exist but is named exactly how it should be, so it survives a skim.",
          "Symptom fixes: when asked to fix a failing test, a model will sometimes change the assertion rather than the bug, making the suite green while the defect stays.",
          "Plausible security holes: string-concatenated SQL, a disabled TLS check left over from 'making it work locally', a secret hardcoded to unblock a demo.",
          "Confident wrong defaults: a Mongo example when your stack is Postgres, naive datetimes, money in floats — patterns the model has seen a million times that happen to be wrong for you.",
        ],
      },
      {
        heading: "Review doesn't scale at machine speed",
        paragraphs: [
          "The natural answer is 'review it more carefully'. But human review was already the weakest link in most pipelines, and it gets weaker as volume rises. A reviewer who sees three AI pull requests an hour, each plausible, each mostly fine, is being trained — efficiently — to approve on vibes. The hundredth clean diff makes the hundred-and-first rubber-stamp.",
          "This is the same dynamic that makes a noisy scanner useless: when most of what you see is fine, you stop really looking. Except here it's worse, because the volume is higher and the failures are camouflaged as competence.",
        ],
      },
      {
        heading: "A gate changes the question",
        paragraphs: [
          "An automated quality gate doesn't get tired and doesn't approve on vibes. It applies the same battery of checks to the thousandth diff as the first: is there a leaked secret, a tainted input reaching a sink, a vulnerable dependency, a disabled cert check, a money value in a float, a naive datetime, a catastrophic regex. It returns a verdict the pipeline obeys.",
          "Crucially, it moves the human's job from 'find the needle' to 'review the gate's findings'. Instead of asking a person to spot a hardcoded key in a 400-line diff, you let the machine point at line 212 and ask the person to decide what to do about it. That's a job humans are actually good at.",
        ],
      },
      {
        heading: "Close the loop, don't just open it",
        paragraphs: [
          "The trap with any scanner is that finding problems creates a backlog. Two hundred findings nobody has time to action protect nothing. The gate has to close the loop: turn the finding into a reviewable fix.",
          "This is where the AI that caused the problem becomes part of the solution. A model is well-suited to taking a specific, located finding and producing a fix — provided the fix is validated (does it actually resolve the finding, does it introduce a new one) and accompanied by a regression test, and provided a human still reviews and merges it. The agent writes fast; the gate keeps it honest; the human stays in the loop where judgement matters.",
        ],
      },
      {
        heading: "The bottom line",
        paragraphs: [
          "AI coding agents don't remove the need for quality control — they raise it, by increasing both the volume of code and the subtlety of its failures. The teams that win with AI aren't the ones who trust it most; they're the ones who pair its speed with a gate that's equally fast and never tired. AI writes fast. Something has to keep it honest.",
        ],
      },
    ],
    related: ["sast-vs-dast-vs-sca", "cutting-false-positives-in-static-analysis"],
    faqs: [
      {
        q: "Does AI-generated code have more bugs than human code?",
        a: "Not necessarily more, but a different distribution. AI code adds failure modes like invented APIs, symptom-fix test changes, and confidently-wrong defaults that look correct at a glance — which is precisely why an automated gate matters more as AI volume rises.",
      },
      {
        q: "Can't I just review AI code carefully?",
        a: "Human review degrades as volume rises: a stream of plausible, mostly-fine diffs trains reviewers to approve on vibes. A gate applies the same checks to every diff regardless of volume and points the reviewer at the specific lines that need a decision.",
      },
    ],
  },
  {
    slug: "sast-vs-dast-vs-sca",
    title: "SAST vs DAST vs SCA: What Each Catches (and Misses)",
    description:
      "Three acronyms cover most of application security scanning, and they are not interchangeable. Each sees a different slice of your risk — and has a blind spot the others cover. Here's a practical breakdown of when to use which.",
    datePublished: "2026-05-20",
    readTime: "7 min read",
    tags: ["security", "SAST", "DAST", "SCA"],
    sections: [
      {
        paragraphs: [
          "If you've shopped for security tooling, you've drowned in three-letter acronyms. The three that matter most — SAST, DAST, and SCA — describe genuinely different techniques that catch genuinely different bugs. Treating any one as 'application security' leaves a hole. Here's what each actually does, with the blind spots stated honestly.",
        ],
      },
      {
        heading: "SAST: reading the code at rest",
        paragraphs: [
          "Static Application Security Testing analyses source code without running it. It parses your code into a tree and looks for dangerous patterns: user input flowing into a SQL query, a secret in plaintext, a shell command built from a request parameter, a regex that backtracks catastrophically.",
          "SAST's superpower is that it's early and precise about location. It runs in the editor and in CI, and it points at an exact file and line while the author still has the context. That makes it the cheapest place to catch a whole class of code-level vulnerability.",
          "Its blind spot is runtime and configuration. SAST can't see that your reverse proxy forwards an internal header, that a cookie is missing the Secure flag in production, or that an admin route is reachable without auth — because none of that is visible in the source alone. It also reasons over all paths, so it can flag code that's safe in practice (false positives).",
        ],
      },
      {
        heading: "DAST: poking the running app",
        paragraphs: [
          "Dynamic Application Security Testing treats the deployed app as a black box and attacks it: crafted requests, a headless browser, fuzzed payloads. It finds what an attacker would find — broken authentication, missing security headers, a 500 that leaks a stack trace, server misconfiguration.",
          "DAST's superpower is that it tests the real system, with its real config and infrastructure. It catches whole categories SAST structurally can't.",
          "Its blind spot is that it needs something deployed and reachable, it runs later, and a finding describes a symptom (an exposed endpoint) without always pointing at the responsible line. It also only exercises the paths it manages to reach, so coverage depends on how well it's driven.",
        ],
      },
      {
        heading: "SCA: auditing what you didn't write",
        paragraphs: [
          "Software Composition Analysis inventories your third-party dependencies and checks them against vulnerability and license databases. Your own code might be flawless and still ship a critical CVE three levels deep in the dependency tree — Log4Shell is the canonical example.",
          "SCA's superpower is reach into code you never read. It answers 'are we shipping a vulnerable package, and where' — the question that turns a CVE disclosure from a multi-day grep into a lookup.",
          "Its blind spot is that it says nothing about how you use a dependency or about your own logic. A package can be CVE-free and still be called in a way that creates a vulnerability — that's SAST's job, not SCA's.",
        ],
      },
      {
        heading: "Putting it together",
        bullets: [
          "Use SAST on every commit for code-level flaws caught early with a precise location.",
          "Use DAST against staging on every deploy for runtime and configuration issues.",
          "Use SCA continuously for vulnerable and risky dependencies, because the graph changes under you.",
          "Expect overlap and gaps: none is a superset of another, and the union is still not 'everything'.",
        ],
      },
      {
        heading: "Where GateTest sits",
        paragraphs: [
          "GateTest is primarily a SAST engine — most of its 110 modules read code at rest — with SCA built in (the dependencies and CVE-feed modules) and a DAST slice (the live browser-driven probes that run where a runner and target URL exist). The point isn't that one tool is all three perfectly; it's that one gate covering all three slices beats three disconnected tools with three dashboards and three bills.",
        ],
      },
    ],
    related: ["why-ai-generated-code-needs-a-qa-gate", "cutting-false-positives-in-static-analysis"],
    faqs: [
      {
        q: "Is SAST or DAST better?",
        a: "Neither — they catch different bugs. SAST reads source code and finds code-level flaws early with a precise location; DAST tests a running app and finds runtime and configuration issues. A complete program runs both.",
      },
      {
        q: "Do I still need SCA if I have SAST?",
        a: "Yes. SAST analyses code you wrote; SCA analyses the third-party dependencies you pulled in. Most real-world breaches involve one or the other, and a vulnerable dependency is invisible to a tool that only reads first-party code.",
      },
    ],
  },
  {
    slug: "cutting-false-positives-in-static-analysis",
    title: "Cutting Static-Analysis False Positives Without Missing Real Bugs",
    description:
      "The false-positive rate is the single biggest reason security scanners get switched off. But naively suppressing findings hides real bugs too. Here are the techniques that lower noise without lowering coverage.",
    datePublished: "2026-05-12",
    readTime: "9 min read",
    tags: ["static analysis", "false positives", "SAST"],
    sections: [
      {
        paragraphs: [
          "Every team that has rolled out a static analyzer knows the failure mode: the tool fires hundreds of findings, a few are real, most aren't, and within a sprint everyone has learned to bulk-dismiss the lot. The scanner is technically still running. It's protecting nothing.",
          "The false-positive rate — the share of findings that aren't real problems — is the metric that governs whether a scanner gets used or quietly abandoned. But the naive fix (suppress more aggressively) trades false positives for false negatives: hide the noise and you hide real bugs with it. The actual engineering problem is lowering noise without lowering coverage. Here's how.",
        ],
      },
      {
        heading: "1. Path-aware severity",
        paragraphs: [
          "The same pattern means different things in different places. A hardcoded credential in `src/` is an error; the identical string in `fixtures/` or `*.test.ts` is almost always a test value. A `Math.random()` in production code is a concern; in a test it's usually fine.",
          "Path-aware severity downgrades findings in test, fixture, story, and example paths rather than firing them at full severity. The finding still appears — you haven't blinded the tool — but it doesn't block the build or scream for attention where it almost certainly doesn't matter.",
        ],
      },
      {
        heading: "2. Library-aware safe harbours",
        paragraphs: [
          "A huge fraction of false positives come from not recognising that the code already did the safe thing. A money value in a float is a bug — unless the file imports decimal.js or big.js, in which case the arithmetic is exact. A raw SQL string is injection-shaped — unless it's a parameterised query through a known ORM. An unbounded retry loop is a problem — unless it's wrapped by p-retry.",
        ],
        code: {
          lang: "ts",
          content: `// Flagged: money in a float
const total = parseFloat(req.body.amount);   // money-float: error

// Safe-harboured: the file uses a decimal library
import Decimal from "decimal.js";
const total = new Decimal(req.body.amount);   // no finding`,
        },
      },
      {
        heading: "3. Explicit, auditable suppression",
        paragraphs: [
          "Sometimes the tool is right that a pattern is present and the developer is right that it's fine. The answer isn't to weaken the rule globally; it's a local, explicit, reviewable suppression — a `// gatetest-ok` style marker on the line, which shows up in code review so a teammate can see the override and the reason.",
          "This keeps the decision where it belongs (with the author, in the diff) instead of in a global config file nobody reads, and it leaves an audit trail.",
        ],
      },
      {
        heading: "4. Confidence scoring and gating only on high confidence",
        paragraphs: [
          "Not every true finding is equally certain. A detector can often tell the difference between 'this is definitely a leaked AWS key' (high confidence) and 'this string has the entropy of a secret but might be a hash' (lower confidence). If you gate — block the build — only on high-confidence findings and let the rest surface as warnings, you get the enforcement benefit without the noise cost.",
        ],
      },
      {
        heading: "5. Learn from dismissals",
        paragraphs: [
          "The strongest signal about whether a rule is noisy is how often humans dismiss it. If a particular rule is suppressed by customers 90% of the time, that's data: the rule is probably miscalibrated. A feedback loop that watches dismissal rates and recommends severity downgrades turns the crowd's judgement into calibration, so the scanner gets quieter over time exactly where it's wrong — and stays loud where it's right.",
        ],
      },
      {
        heading: "The principle underneath",
        paragraphs: [
          "Every one of these techniques shares a goal: be quiet where you're probably wrong, loud where you're probably right, and never silently drop a finding — downgrade it visibly instead. That's how you earn the one thing a scanner can't function without, which is the developer's trust that a finding is worth looking at.",
        ],
      },
    ],
    related: ["sast-vs-dast-vs-sca", "why-ai-generated-code-needs-a-qa-gate"],
    faqs: [
      {
        q: "What is a good false-positive rate for a SAST tool?",
        a: "Lower is better, but the more important property is that the tool gates only on high-confidence findings and surfaces the rest as warnings. A scanner that blocks builds on noisy findings gets switched off regardless of its raw rate.",
      },
      {
        q: "Doesn't suppressing findings hide real bugs?",
        a: "Naive global suppression does. The techniques that don't — path-aware severity, library-aware safe harbours, explicit per-line suppression, and confidence gating — lower noise without dropping findings silently. A downgraded finding still appears; it just doesn't block.",
      },
    ],
  },
];

export function getAllBlogSlugs(): string[] {
  return BLOG_POSTS.map((p) => p.slug);
}

export function getBlogPostBySlug(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}

export function getRelatedPosts(slug: string, limit = 2): BlogPost[] {
  const post = getBlogPostBySlug(slug);
  if (!post) return [];
  const out: BlogPost[] = [];
  for (const rel of post.related) {
    const p = getBlogPostBySlug(rel);
    if (p) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
