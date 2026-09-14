<?php
/**
 * GateTest Health Check — Uninstall cleanup.
 *
 * Runs when the user clicks "Delete" on the plugin in the WordPress admin.
 * Cleans up all plugin-created options + transients + scheduled events.
 *
 * NOTE: nothing is stored on gatetest.io for the free health check;
 * a paid full report is tied to its Stripe checkout on gatetest.io, so
 * uninstalling the plugin does not affect it.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('gatetest_hc_api_key');
delete_option('gatetest_hc_last_scan_at');
delete_option('gatetest_hc_consent_url_share');

delete_transient('gatetest_hc_last_result');

if (function_exists('wp_clear_scheduled_hook')) {
    wp_clear_scheduled_hook('gatetest_hc_weekly_scan');
}
