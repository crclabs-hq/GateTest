<?php
/**
 * Plugin Name:       GateTest Health Check
 * Plugin URI:        https://gatetest.io
 * Description:       Audit your WordPress site for 18+ security, performance, and quality issues. Plain-language report. Powered by the GateTest engine.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Tested up to:      7.1
 * Requires PHP:      7.4
 * Author:            GateTest
 * Author URI:        https://gatetest.io
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       gatetest-health-check
 *
 * GateTest Health Check is a thin client for the gatetest.io scan engine.
 * It does NOT do the scanning locally — that runs at gatetest.io. This plugin:
 *
 *   1. Adds an admin menu page under Tools → GateTest
 *   2. Captures the site's URL, WordPress version and plugin version
 *   3. Sends a scan request to https://gatetest.io/api/wp/scan
 *   4. Renders the plain-language report inside the admin UI
 *
 * No source code is sent. The scan probes the site over HTTP from gatetest.io's
 * infrastructure — same way a customer running a manual scan on the website
 * would experience it. Plugin acts as the convenient launcher + result viewer.
 *
 * The health check is free and needs no account. The paid full report
 * ($19, one-time) is bought and delivered on gatetest.io/wp; the plugin
 * only links to it.
 *
 * Privacy: site URL, WP version and plugin version are sent. No content, no credentials, no
 * database data. See https://gatetest.io/legal/privacy for the full data
 * handling contract.
 */

// Block direct access — required for WP.org directory compliance.
if (!defined('ABSPATH')) {
    exit;
}

define('GATETEST_HC_VERSION', '0.1.0');
define('GATETEST_HC_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('GATETEST_HC_PLUGIN_URL', plugin_dir_url(__FILE__));
define('GATETEST_HC_API_BASE', 'https://gatetest.io');

// Load includes.
require_once GATETEST_HC_PLUGIN_DIR . 'includes/admin-page.php';
require_once GATETEST_HC_PLUGIN_DIR . 'includes/scanner.php';
require_once GATETEST_HC_PLUGIN_DIR . 'includes/api-client.php';

/**
 * Plugin activation — runs once on install.
 *
 * Creates the default options. No DB tables — the latest scan result lives
 * in a single transient (7 days) plus a timestamp option.
 */
function gatetest_hc_activate() {
    add_option('gatetest_hc_last_scan_at', 0);
    add_option('gatetest_hc_api_key', ''); // Optional; set by the user via Settings.
    add_option('gatetest_hc_consent_url_share', 'false');
}
register_activation_hook(__FILE__, 'gatetest_hc_activate');

/**
 * Plugin deactivation — clears scheduled scans + transients.
 */
function gatetest_hc_deactivate() {
    wp_clear_scheduled_hook('gatetest_hc_weekly_scan');
    delete_transient('gatetest_hc_last_result');
}
register_deactivation_hook(__FILE__, 'gatetest_hc_deactivate');

/**
 * Boot the admin UI when WordPress loads admin pages.
 */
add_action('admin_menu', 'gatetest_hc_register_admin_menu');
add_action('admin_init', 'gatetest_hc_register_settings');
add_action('admin_enqueue_scripts', 'gatetest_hc_enqueue_assets');

/**
 * AJAX endpoint — kick off a scan from the admin button.
 */
add_action('wp_ajax_gatetest_hc_run_scan', 'gatetest_hc_handle_run_scan');

/**
 * Weekly scheduled health check — the same free scan as the button, opted
 * in via Settings and delivered through WP-Cron.
 */
add_action('gatetest_hc_weekly_scan', 'gatetest_hc_run_scheduled_scan');
