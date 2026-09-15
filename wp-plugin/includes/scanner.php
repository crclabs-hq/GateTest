<?php
/**
 * Scan orchestration — runs from the AJAX endpoint and from the weekly cron.
 *
 * Both paths run the same free health check (the server decides what a
 * paid full report is from a Stripe session on gatetest.io, never from
 * this plugin), and both store the result the same way so the admin page
 * shows whichever ran last.
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Run the free health check against this site and store the result.
 *
 * @return array|WP_Error The decoded report, or the error the API client returned.
 */
function gatetest_hc_run_health_check() {
    $result = gatetest_hc_request_scan(get_option('gatetest_hc_api_key', ''), home_url(), [
        'full_report' => false,
    ]);
    if (is_wp_error($result)) {
        return $result;
    }
    update_option('gatetest_hc_last_scan_at', time());
    set_transient('gatetest_hc_last_result', $result, DAY_IN_SECONDS * 7);
    return $result;
}

/**
 * AJAX handler for the "Scan my site now" button.
 *
 * Wired in the main plugin file:
 *   add_action('wp_ajax_gatetest_hc_run_scan', 'gatetest_hc_handle_run_scan');
 */
function gatetest_hc_handle_run_scan() {
    // Capability + nonce check — required for admin AJAX.
    if (!current_user_can('manage_options')) {
        wp_send_json_error([
            'message' => __('Insufficient permissions.', 'gatetest-health-check'),
        ], 403);
    }

    check_ajax_referer('gatetest_hc_scan', 'nonce');

    $result = gatetest_hc_run_health_check();

    if (is_wp_error($result)) {
        wp_send_json_error([
            'message' => $result->get_error_message(),
            'code'    => $result->get_error_code(),
        ], 500);
    }

    wp_send_json_success($result);
}

/**
 * Scheduled weekly health check — registered when the user opts in via Settings.
 */
function gatetest_hc_run_scheduled_scan() {
    if (get_option('gatetest_hc_consent_url_share', 'false') !== 'true') {
        return;
    }
    $result = gatetest_hc_run_health_check();
    if (is_wp_error($result) && defined('WP_DEBUG') && WP_DEBUG) {
        // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- debug builds only.
        error_log('[gatetest-hc] Scheduled scan failed: ' . $result->get_error_message());
    }
}

/**
 * Make the WP-Cron schedule match the saved setting: scheduled when it is
 * 'true', cleared for anything else (including the '' options.php stores
 * for an unticked checkbox — which the old on/off branches both ignored,
 * so the weekly scan could never be switched off).
 */
function gatetest_hc_sync_weekly_schedule() {
    $enabled   = get_option('gatetest_hc_consent_url_share', 'false') === 'true';
    $scheduled = (bool) wp_next_scheduled('gatetest_hc_weekly_scan');
    if ($enabled && !$scheduled) {
        // Next Sunday 3am UTC, then weekly.
        wp_schedule_event(strtotime('next Sunday 03:00 UTC'), 'weekly', 'gatetest_hc_weekly_scan');
    } elseif (!$enabled && $scheduled) {
        wp_clear_scheduled_hook('gatetest_hc_weekly_scan');
    }
}
add_action('update_option_gatetest_hc_consent_url_share', 'gatetest_hc_sync_weekly_schedule');
add_action('add_option_gatetest_hc_consent_url_share', 'gatetest_hc_sync_weekly_schedule');
