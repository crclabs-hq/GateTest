/**
 * CWE (Common Weakness Enumeration) catalogue for /find/[slug] pages.
 *
 * Source: MITRE 2023 CWE Top 25 Most Dangerous Software Weaknesses
 * (https://cwe.mitre.org/top25/archive/2023/2023_top25_list.html).
 *
 * Each entry includes:
 *   - the public CWE id and name (MITRE-defined)
 *   - the URL slug we publish at
 *   - a short description in our own words (not a verbatim copy)
 *   - the GateTest module(s) that catch this class — only modules
 *     that genuinely apply; we say "Not covered by GateTest today"
 *     for the C/C++ memory-safety classes we don't address
 *
 * Green-system principle: every claim is defensible. If a CWE class
 * is one we don't catch (CWE-787 Out-of-bounds Write, etc.), we say
 * so. Honest = trustworthy = ranks well.
 */

export interface CweEntry {
  /** MITRE numeric id without the "CWE-" prefix. */
  id: number;
  /** MITRE-defined short name. */
  name: string;
  /** URL slug (kebab-case, includes id). */
  slug: string;
  /** Our short description — not a verbatim CWE quote. */
  shortDesc: string;
  /** GateTest modules that catch this class. Empty when we don't cover it. */
  modules: string[];
  /** A real example of the vulnerability shape. */
  example: string;
  /** The high-level remediation we recommend. */
  remediation: string;
  /** Rank in the MITRE 2023 Top 25. */
  rank: number;
}

export const CWE_TOP_25: CweEntry[] = [
  {
    rank: 1, id: 787, name: "Out-of-bounds Write",
    slug: "cwe-787-out-of-bounds-write",
    shortDesc: "A buffer write that lands outside the allocated bounds, corrupting memory and enabling exploitation. Almost exclusively a C/C++ vulnerability.",
    modules: [],
    example: "strcpy(buffer, user_input) where buffer is 256 bytes and user_input is 1 KB.",
    remediation: "Use memory-safe languages (Rust, Go) or bounded-copy APIs (strncpy_s, memcpy_s). GateTest does not currently scan C/C++ source — for that, pair us with a tool like CodeQL or AFL.",
  },
  {
    rank: 2, id: 79, name: "Cross-Site Scripting (XSS)",
    slug: "cwe-79-xss",
    shortDesc: "User-controlled input is rendered into HTML or JavaScript context without escaping, letting an attacker execute script in another user's browser.",
    modules: ["security", "crossFileTaint"],
    example: "<div dangerouslySetInnerHTML={{ __html: req.query.q }} /> in a React component.",
    remediation: "Escape on output. Use a templating engine that escapes by default (React, Jinja2, Razor). Add a strict CSP as defence in depth. GateTest's security and crossFileTaint modules catch the common patterns.",
  },
  {
    rank: 3, id: 89, name: "SQL Injection",
    slug: "cwe-89-sql-injection",
    shortDesc: "User input is concatenated directly into a SQL query, letting the attacker change the query's logic — read other users' data, drop tables, or execute arbitrary SQL.",
    modules: ["crossFileTaint", "security"],
    example: "const q = 'SELECT * FROM users WHERE id = ' + req.params.id; client.query(q)",
    remediation: "Use parameterised queries / prepared statements. Never concatenate user input into SQL. ORMs (Prisma, Sequelize, Drizzle) parameterise by default; if you use raw queries, parameterise them. crossFileTaint flags taint from req.body/query/params into query() calls.",
  },
  {
    rank: 4, id: 416, name: "Use After Free",
    slug: "cwe-416-use-after-free",
    shortDesc: "Memory is referenced after it has been freed. Common in C/C++; a frequent root cause of zero-day exploits in browsers and kernels.",
    modules: [],
    example: "free(ptr); ... ptr->method(); — ptr now references reclaimed or attacker-controlled memory.",
    remediation: "Use memory-safe languages (Rust's ownership model, Go's GC). Static analyzers like Clang Static Analyzer or CodeQL catch many cases. GateTest does not scan C/C++ today.",
  },
  {
    rank: 5, id: 78, name: "OS Command Injection",
    slug: "cwe-78-os-command-injection",
    shortDesc: "User input is interpolated into a shell command, letting the attacker execute arbitrary commands on the host.",
    modules: ["security", "crossFileTaint"],
    example: "exec('convert ' + req.body.filename + ' output.png')",
    remediation: "Use exec/spawn variants that take an args ARRAY (not a shell string) so arguments can't be reinterpreted. Validate filenames against an allowlist. Never pass req.body / req.query / req.params straight into a shell.",
  },
  {
    rank: 6, id: 20, name: "Improper Input Validation",
    slug: "cwe-20-improper-input-validation",
    shortDesc: "The application accepts input without validating shape, length, range, or type — and that input later violates an assumption.",
    modules: ["security", "ssrf", "crossFileTaint"],
    example: "Accepting any string as a URL and fetching it without checking the host.",
    remediation: "Validate at the boundary. Use schema libraries (zod, joi, ajv, pydantic) at every external input. Allowlist over blocklist. GateTest's ssrf and crossFileTaint modules flag the common skip-validation patterns.",
  },
  {
    rank: 7, id: 125, name: "Out-of-bounds Read",
    slug: "cwe-125-out-of-bounds-read",
    shortDesc: "Reading memory outside an allocated buffer. Leaks adjacent data, sometimes secrets. C/C++ class.",
    modules: [],
    example: "for (i = 0; i <= len; i++) printf('%c', buffer[i]); — off-by-one reads one byte past end.",
    remediation: "Use memory-safe languages or bounded-read APIs. GateTest does not scan C/C++ today.",
  },
  {
    rank: 8, id: 22, name: "Path Traversal",
    slug: "cwe-22-path-traversal",
    shortDesc: "User input is used as a file path without restricting it to an intended directory, letting the attacker read or write arbitrary files via ../",
    modules: ["security", "crossFileTaint"],
    example: "fs.readFile('./uploads/' + req.query.filename) — req.query.filename = '../../../../etc/passwd'",
    remediation: "Never use user input as a path component. Look up files by opaque ID server-side. If you must accept names, validate against an allowlist and use path.resolve() + a startsWith() check against the intended root.",
  },
  {
    rank: 9, id: 352, name: "Cross-Site Request Forgery (CSRF)",
    slug: "cwe-352-csrf",
    shortDesc: "An attacker tricks an authenticated user's browser into making a request to your site, riding the user's session cookie.",
    modules: ["cookieSecurity", "webHeaders"],
    example: "A bank's /transfer endpoint accepts GET parameters; an attacker embeds <img src='/transfer?to=evil&amount=1000'> on another site.",
    remediation: "Use SameSite=Lax or SameSite=Strict on session cookies. Verify CSRF tokens on state-changing requests. cookieSecurity flags missing SameSite. webHeaders flags missing CSP frame-ancestors.",
  },
  {
    rank: 10, id: 434, name: "Unrestricted Upload of File with Dangerous Type",
    slug: "cwe-434-unrestricted-file-upload",
    shortDesc: "Accepting arbitrary file uploads without validating type, size, or content, letting an attacker upload a .php, .jsp, or malicious binary.",
    modules: ["security"],
    example: "app.post('/upload', upload.single('file'), (req, res) => { fs.writeFileSync('./public/' + req.file.originalname, req.file.buffer) })",
    remediation: "Validate MIME type AND file magic-bytes (don't trust the extension). Store outside the web root. Rename to a hash on save. Set a strict size limit. Never serve uploads from a directory where they can be executed.",
  },
  {
    rank: 11, id: 862, name: "Missing Authorization",
    slug: "cwe-862-missing-authorization",
    shortDesc: "An endpoint enforces authentication but not authorisation — any logged-in user can access any other user's data.",
    modules: ["authFlaws"],
    example: "app.get('/api/users/:id/orders', authMiddleware, async (req, res) => { res.json(await db.query('SELECT * FROM orders WHERE user_id = $1', [req.params.id])) }) — any logged-in user can read any user's orders.",
    remediation: "On every endpoint that returns user-owned data, compare req.user.id to the requested record's owner. Test with two real accounts.",
  },
  {
    rank: 12, id: 476, name: "NULL Pointer Dereference",
    slug: "cwe-476-null-pointer-dereference",
    shortDesc: "Dereferencing a pointer that may be NULL, causing a crash or worse. C/C++/Java NullPointerException class.",
    modules: [],
    example: "User *u = find_user(name); printf('%s', u->email); — if find_user returns NULL on miss, this crashes.",
    remediation: "Check for null before dereferencing. Use Option / Maybe / Result types in languages that support them. GateTest does not currently scan for this class.",
  },
  {
    rank: 13, id: 287, name: "Improper Authentication",
    slug: "cwe-287-improper-authentication",
    shortDesc: "Authentication is incorrectly implemented — weak password rules, accepting tokens without verifying signature, accepting empty credentials, etc.",
    modules: ["authFlaws", "secrets"],
    example: "if (req.body.password == storedPassword) { ... } — timing-attackable + no rate limit + no hashing.",
    remediation: "Use a vetted auth library (Lucia, NextAuth, Devise, Spring Security). Hash passwords with bcrypt/argon2. Rate-limit login attempts. Verify JWT signatures and audience. authFlaws flags the common gaps.",
  },
  {
    rank: 14, id: 190, name: "Integer Overflow or Wraparound",
    slug: "cwe-190-integer-overflow",
    shortDesc: "Arithmetic produces a result the variable's type can't hold, wrapping silently. Most common in lower-level languages.",
    modules: [],
    example: "uint32_t total = price * quantity; — wraps to a small number for large purchases.",
    remediation: "Use checked arithmetic, BigInt where appropriate. Validate ranges at boundaries. GateTest does not currently catch this class.",
  },
  {
    rank: 15, id: 502, name: "Deserialization of Untrusted Data",
    slug: "cwe-502-deserialization-of-untrusted-data",
    shortDesc: "Deserialising attacker-controlled bytes into native objects, letting the attacker construct unexpected types that trigger code execution via magic methods.",
    modules: ["security"],
    example: "pickle.loads(request.body) in Python — Pickle is trivially exploitable; the loaded object can execute arbitrary code.",
    remediation: "Don't accept serialised native objects from the network. Use JSON for data interchange. If you must deserialise, use schemas (Avro, Protobuf with explicit types) and validate.",
  },
  {
    rank: 16, id: 77, name: "Command Injection",
    slug: "cwe-77-command-injection",
    shortDesc: "Like OS Command Injection (CWE-78) but broader — any interpreter that builds commands from input is vulnerable.",
    modules: ["security", "crossFileTaint"],
    example: "subprocess.run('git pull origin ' + branch, shell=True)",
    remediation: "Use args arrays, not shell strings. Validate against allowlists. crossFileTaint flags taint reaching exec/spawn.",
  },
  {
    rank: 17, id: 119, name: "Buffer Overflow",
    slug: "cwe-119-buffer-overflow",
    shortDesc: "Writes past the end of a buffer. Classic memory-safety bug; almost always C/C++.",
    modules: [],
    example: "char dst[16]; strcpy(dst, user_input);",
    remediation: "Memory-safe languages or bounded-copy APIs. GateTest does not scan C/C++.",
  },
  {
    rank: 18, id: 798, name: "Use of Hard-coded Credentials",
    slug: "cwe-798-hardcoded-credentials",
    shortDesc: "API keys, passwords, tokens, or private keys are committed directly into source code where anyone with repo access (or git history) can read them.",
    modules: ["secrets", "secretRotation"],
    example: "const STRIPE_KEY = 'sk_live_51A2B...'; — committed to git, leaked the moment the repo is public or a contractor leaves.",
    remediation: "Use environment variables. For local dev, .env files (gitignored). For prod, a vault (1Password Connect, Vault, AWS Secrets Manager). Rotate any key that was ever committed. secrets and secretRotation catch both fresh leaks and stale credentials.",
  },
  {
    rank: 19, id: 918, name: "Server-Side Request Forgery (SSRF)",
    slug: "cwe-918-ssrf",
    shortDesc: "An endpoint fetches a URL from user input without validating the destination, letting an attacker hit internal services (metadata endpoints, databases, admin panels).",
    modules: ["ssrf"],
    example: "fetch(req.query.url) — attacker passes http://169.254.169.254/latest/meta-data/iam/security-credentials and exfiltrates AWS credentials.",
    remediation: "Never let user input determine the destination host. Use an allowlist of permitted hosts. Reject private IP ranges and cloud metadata endpoints. The ssrf module flags taint from req.* to fetch/axios/got/http.request without a validator.",
  },
  {
    rank: 20, id: 306, name: "Missing Authentication for Critical Function",
    slug: "cwe-306-missing-authentication",
    shortDesc: "An endpoint that performs a critical action (delete account, change password, transfer funds) doesn't require authentication.",
    modules: ["authFlaws"],
    example: "app.post('/admin/delete-user/:id', async (req, res) => { ... }) — no auth middleware.",
    remediation: "Require authentication on every state-changing endpoint by default; make public endpoints opt-in. Audit your routing table for missing middleware. authFlaws catches the obvious cases.",
  },
  {
    rank: 21, id: 362, name: "Race Condition",
    slug: "cwe-362-race-condition",
    shortDesc: "Two execution paths share state without proper synchronisation; the outcome depends on timing. Classic forms include TOCTOU (time-of-check vs time-of-use) and lost updates in databases.",
    modules: ["raceCondition"],
    example: "if (fs.existsSync(path)) { fs.unlinkSync(path) } — between exists and unlink, an attacker swaps the file to a symlink.",
    remediation: "For filesystem: avoid check-then-act; use atomic operations (open with O_CREAT|O_EXCL). For databases: use transactions and SELECT FOR UPDATE or UPSERT. raceCondition catches the common JS/Node TOCTOU + ORM get-or-create patterns.",
  },
  {
    rank: 22, id: 269, name: "Improper Privilege Management",
    slug: "cwe-269-improper-privilege-management",
    shortDesc: "Code runs with more privilege than it needs, or fails to drop privileges before processing untrusted input.",
    modules: ["dockerfile", "kubernetes"],
    example: "USER root in a Dockerfile that runs a public-facing web server — any code execution becomes root code execution.",
    remediation: "Principle of least privilege. Run as a non-root user. Use Kubernetes runAsNonRoot, securityContext, capabilities drop. dockerfile and kubernetes modules catch the common over-privilege patterns.",
  },
  {
    rank: 23, id: 94, name: "Code Injection",
    slug: "cwe-94-code-injection",
    shortDesc: "User input is evaluated as code — eval(), Function(), exec(), or template engines that allow expression execution.",
    modules: ["security", "crossFileTaint"],
    example: "const result = eval(req.body.expression) — attacker passes 'process.exit(1)' and your server falls over (best case).",
    remediation: "Never use eval / new Function with user input. For dynamic logic, use a sandboxed expression evaluator (mathjs, jsep) with an explicit allowed-function list. security and crossFileTaint flag eval / new Function sinks.",
  },
  {
    rank: 24, id: 863, name: "Incorrect Authorization",
    slug: "cwe-863-incorrect-authorization",
    shortDesc: "Authorisation is implemented but wrong — checking the wrong field, comparing strings non-constant-time, or allowing the user to set their own role.",
    modules: ["authFlaws"],
    example: "if (req.body.role === 'admin') grantAdmin() — trusting a client-provided role field.",
    remediation: "Authorisation belongs server-side, against persisted state. Never accept role / permission claims from the client. Use a vetted policy library (Casbin, OPA). authFlaws catches the common pattern errors.",
  },
  {
    rank: 25, id: 276, name: "Incorrect Default Permissions",
    slug: "cwe-276-incorrect-default-permissions",
    shortDesc: "Files, directories, S3 buckets, or database tables are created with overly permissive default access (world-readable, public, etc).",
    modules: ["terraform", "kubernetes", "dockerfile"],
    example: "Public S3 bucket policy with Principal: '*' on s3:GetObject, used to host private user uploads.",
    remediation: "Audit IaC for permissive defaults. terraform flags public S3, IAM wildcards, 0.0.0.0/0 security-group rules. kubernetes flags hostNetwork, privileged, allowPrivilegeEscalation. dockerfile flags chmod 777.",
  },
];

/**
 * Build a slug → entry index.
 */
export function buildCweIndex(): Map<string, CweEntry> {
  const out = new Map<string, CweEntry>();
  for (const e of CWE_TOP_25) out.set(e.slug, e);
  return out;
}

export function getAllCweSlugs(): string[] {
  return CWE_TOP_25.map((e) => e.slug);
}

export function getCweBySlug(slug: string): CweEntry | null {
  return buildCweIndex().get(slug) || null;
}

export function getRelatedCwes(slug: string, limit = 4): CweEntry[] {
  const me = getCweBySlug(slug);
  if (!me) return [];
  // Related by shared module overlap, then by adjacent rank
  const scored = CWE_TOP_25
    .filter((e) => e.slug !== slug)
    .map((e) => ({
      e,
      overlap: e.modules.filter((m) => me.modules.includes(m)).length,
      rankGap: Math.abs(e.rank - me.rank),
    }))
    .sort((a, b) => b.overlap - a.overlap || a.rankGap - b.rankGap);
  return scored.slice(0, limit).map((s) => s.e);
}
