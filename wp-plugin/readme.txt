=== GateTest Health Check ===
Contributors: gatetest
Tags: security, audit, performance, accessibility, seo, malware, plugin scanner
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Free WordPress health check from inside wp-admin: security, performance, accessibility and SEO issues in a plain-language report. Powered by gatetest.io.

== Description ==

**GateTest Health Check** runs the gatetest.io WordPress audit against your site from the **Tools → GateTest** page and shows the result in plain language. No account, no API key, no charge.

You probably already use Wordfence for the firewall, Yoast for SEO, WP Rocket for performance, and Sucuri for cleanup. GateTest does NOT replace them — it's the **audit layer that tells you what's actually wrong across all of those concerns in one scan**.

= What it checks =

* Exposed sensitive files (wp-config.php.bak, debug.log, .git, .env, SQL backups)
* WordPress version leak vectors (readme.html, meta generator, RSS feed)
* XML-RPC exposure + pingback DDoS reflector risk
* Plugin CVEs (cross-referenced against a curated 2024-2026 database)
* Active theme abandonment / known theme CVEs
* Malware patterns in your rendered HTML (eval/atob, hidden iframes, base64 payloads)
* Username enumeration vectors (?author=1 redirect, REST API leak)
* Admin login hardening (WAF, 2FA detection, cookie hardening)
* PHP version end-of-life status
* Backup plugin presence + exposed-backup detection
* HTTPS / TLS configuration + missing security headers
* Cookie hardening (HttpOnly, Secure, SESSION_COOKIE_* flags)
* Accessibility issues (WCAG 2.1 AA via axe-core)
* SEO basics (meta, schema.org, sitemap, hreflang)
* Broken links + dead images
* Performance / Core Web Vitals

= What it does NOT do =

* Remove malware (Sucuri's lane)
* Block attackers in real time (Wordfence / Cloudflare's lane)
* Take backups (UpdraftPlus is free; we tell you if you don't have it)
* Change anything on your site — it reads, it never writes

We are the **audit** layer. We tell you exactly what's wrong, where, and how to fix it. The other tools handle the active defence; we make sure they're configured correctly and nothing slipped through.

= How it works =

1. Go to **Tools → GateTest** in your WordPress admin
2. Click "Scan my site now" — no account, no API key
3. Read the report on the same page

The scan runs on gatetest.io's infrastructure — your site is probed over HTTP from outside, same way an attacker would see it. No source code is sent to us; only your site's URL, WordPress version and plugin version.

= Pricing =

The health check in this plugin is free and shows the three most urgent findings. If there are more, the plugin tells you how many and links to the **full report — a one-time $19 purchase on gatetest.io** (no subscription): every finding, with step-by-step fix instructions. The full report is delivered on gatetest.io, not inside WordPress. See [gatetest.io/wp](https://gatetest.io/wp).

== Installation ==

1. Upload the `gatetest-health-check` plugin to the `/wp-content/plugins/` directory, or install through the WordPress plugin directory.
2. Activate the plugin through the **Plugins** menu in WordPress.
3. Go to **Tools → GateTest** and click "Scan my site now".

== Frequently Asked Questions ==

= Does this plugin slow down my site? =

No. The scan runs on gatetest.io's servers — not yours. Your site experiences the same network traffic as a regular visitor making a few HTTP requests. The plugin runs nothing in the background unless you tick the optional weekly scan, which uses WP-Cron to request one free health check a week. The plugin file weighs less than 50KB.

= What data is sent to gatetest.io? =

Your site's public URL, your WordPress version and the plugin version. No source code, no database content, no credentials, no plugin list, no theme data. The scan probes your site from the outside.

= Do I need an account or an API key? =

No. The free health check runs without either. The API Key field in Settings is optional and reserved for the paid full report.

= Is the free health check enough? =

For most sites, it surfaces the top 3 most urgent findings. That's enough to know whether you need to dig deeper. If everything looks clean, you probably don't need the full report.

= How does this compare to Wordfence? =

Wordfence is a firewall — it blocks attacks in real time. GateTest is an audit — it tells you what's wrong before you get attacked. Use both. They don't overlap.

== Changelog ==

= 0.1.0 =
* Initial release: free health check under Tools → GateTest, plain-language findings on the same page, optional weekly re-check via WP-Cron.

== Privacy ==

Full privacy policy at [gatetest.io/legal/privacy](https://gatetest.io/legal/privacy).
