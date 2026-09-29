CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  payment_intent_id TEXT,
  customer_email TEXT,
  repo_url TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Results (JSONB, no more 500-char Stripe metadata limit)
  results JSONB,
  summary TEXT,
  score INTEGER,

  -- Cost tracking
  ai_cost_usd NUMERIC(10,4),
  tier_price_usd NUMERIC(10,2),

  -- Metadata
  modules_run TEXT[],
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  github_login TEXT,
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  total_scans INTEGER DEFAULT 0,
  total_spent_usd NUMERIC(10,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS installations (
  id BIGSERIAL PRIMARY KEY,
  host TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  customer_email TEXT,
  customer_login TEXT,
  setup_action TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (host, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_scans_session ON scans(session_id);
CREATE INDEX IF NOT EXISTS idx_scans_email ON scans(customer_email);
CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_github ON customers(github_login);
CREATE INDEX IF NOT EXISTS idx_installations_host_id ON installations(host, installation_id);
CREATE INDEX IF NOT EXISTS idx_installations_customer_email ON installations(customer_email);

-- Watchdog: continuously monitored domains/repos
CREATE TABLE IF NOT EXISTS watches (
  id BIGSERIAL PRIMARY KEY,
  owner_login TEXT NOT NULL,          -- who owns this watch (admin login or customer email)
  target_type TEXT NOT NULL,          -- 'server' | 'repo'
  target TEXT NOT NULL,               -- URL for server, owner/repo for repo
  interval_minutes INTEGER NOT NULL DEFAULT 15,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_checked_at TIMESTAMPTZ,
  last_status TEXT,                   -- 'healthy' | 'degraded' | 'down' | 'healed'
  last_issue_count INTEGER DEFAULT 0,
  auto_fix_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (owner_login, target_type, target)
);

-- Watchdog: log every heal action taken
CREATE TABLE IF NOT EXISTS heal_history (
  id BIGSERIAL PRIMARY KEY,
  watch_id BIGINT REFERENCES watches(id) ON DELETE CASCADE,
  triggered_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  action TEXT NOT NULL,               -- 'scan' | 'auto_fix_pr' | 'redeploy' | 'notify'
  status TEXT NOT NULL,               -- 'success' | 'failed' | 'skipped'
  before_issue_count INTEGER,
  after_issue_count INTEGER,
  pr_url TEXT,
  details JSONB
);

-- Email + password sign-in (password-auth-store.js owns these statements;
-- they run idempotently at first use and from POST /api/db/init).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;          -- scrypt$N$r$p$salt$hash, NULL for OAuth-only
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
  token_hash TEXT NOT NULL UNIQUE,   -- sha256 of the 32-byte link token; the token itself is never stored
  payload TEXT,                      -- verify: the pending password hash, activated on click
  expires_at TIMESTAMPTZ NOT NULL,   -- 1 h after issue
  used_at TIMESTAMPTZ,               -- single use
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_customer_kind ON auth_tokens(customer_id, kind);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at);

-- Sign-in throttle: one row per failed attempt, keyed by sha256(email|ip).
-- 10 rows inside 15 minutes → 429. A table, not a process Map: the site is multi-process.
CREATE TABLE IF NOT EXISTS auth_login_failures (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_login_failures_key_time ON auth_login_failures(scope_key, attempted_at);

CREATE INDEX IF NOT EXISTS idx_watches_owner ON watches(owner_login);
CREATE INDEX IF NOT EXISTS idx_watches_enabled_checked ON watches(enabled, last_checked_at);
CREATE INDEX IF NOT EXISTS idx_heal_history_watch ON heal_history(watch_id, triggered_at DESC);
