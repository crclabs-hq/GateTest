<?php
/**
 * Thin HTTP client for the gatetest.io scan API.
 *
 * All scan work runs server-side at gatetest.io. This file just packs the
 * site's URL into a POST request, parses the JSON response, and returns
 * it. No business logic.
 *
 * The free health check needs no authentication — POST /api/wp/scan is the
 * same public endpoint the gatetest.io/wp page uses. When the user has
 * pasted an API key it is sent as a Bearer token so a future server-side
 * entitlement check can honour it; today the server ignores it and
 * decides the full report from a paid Stripe session, never from a key.
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Request a scan from gatetest.io.
 *
 * @param string $api_key  Optional. The customer's GateTest API key; '' for the free health check.
 * @param string $site_url The site URL to scan (typically home_url()).
 * @param array  $opts     Optional. { full_report?: bool }
 *
 * @return array|WP_Error Decoded JSON response on success, WP_Error on transport / API failure.
 */
function gatetest_hc_request_scan($api_key, $site_url, $opts = []) {
    if (empty($site_url) || !filter_var($site_url, FILTER_VALIDATE_URL)) {
        return new WP_Error(
            'gatetest_hc_invalid_url',
            __('Site URL is invalid.', 'gatetest-health-check')
        );
    }

    $body = wp_json_encode([
        'url'           => $site_url,
        'fullReport'    => !empty($opts['full_report']),
        'source'        => 'wordpress-plugin',
        'wpVersion'     => get_bloginfo('version'),
        'pluginVersion' => GATETEST_HC_VERSION,
    ]);

    $headers = [
        'Content-Type' => 'application/json',
        'Accept'       => 'application/json',
        'User-Agent'   => 'gatetest-health-check/' . GATETEST_HC_VERSION . '; WordPress/' . get_bloginfo('version'),
    ];
    if (!empty($api_key)) {
        $headers['Authorization'] = 'Bearer ' . $api_key;
    }

    $response = wp_remote_post(GATETEST_HC_API_BASE . '/api/wp/scan', [
        'timeout'     => 90, // Server-side scan can take 30-60s.
        'headers'     => $headers,
        'body'        => $body,
        'data_format' => 'body',
    ]);

    if (is_wp_error($response)) {
        return $response;
    }

    $status = wp_remote_retrieve_response_code($response);
    $body   = wp_remote_retrieve_body($response);
    $json   = json_decode($body, true);

    // /api/wp/scan answers 200, 400 (bad URL), 429 (rate limit) or 500; it
    // has no auth branch, so one status-aware error covers every failure.
    if ($status >= 400) {
        $message = is_array($json) && !empty($json['error']) && is_string($json['error'])
            ? sanitize_text_field($json['error'])
            : sprintf(
                /* translators: %d: HTTP status code */
                __('Scan failed (HTTP %d).', 'gatetest-health-check'),
                (int) $status
            );
        return new WP_Error(
            'gatetest_hc_scan_failed',
            $message,
            ['status' => $status, 'response' => $json]
        );
    }

    if (!is_array($json)) {
        return new WP_Error(
            'gatetest_hc_bad_response',
            __('GateTest returned an unparseable response.', 'gatetest-health-check')
        );
    }

    return $json;
}
