<?php
/**
 * Admin UI for GateTest Health Check.
 *
 * Renders the page at Tools → GateTest. Three sections:
 *   1. Run-scan button + status
 *   2. Latest report (if any), rendered as plain-language cards
 *   3. Settings (API key, opt-in to weekly scan)
 */

if (!defined('ABSPATH')) {
    exit;
}

function gatetest_hc_register_admin_menu() {
    add_management_page(
        __('GateTest Health Check', 'gatetest-health-check'),
        __('GateTest', 'gatetest-health-check'),
        'manage_options',
        'gatetest-health-check',
        'gatetest_hc_render_admin_page'
    );
}

function gatetest_hc_register_settings() {
    register_setting('gatetest_hc_settings', 'gatetest_hc_api_key', [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => '',
    ]);
    // An unchecked checkbox submits nothing, which options.php stores as ''.
    // Normalise to the two values the scheduler understands so "off" is
    // never a third state that neither branch handles.
    register_setting('gatetest_hc_settings', 'gatetest_hc_consent_url_share', [
        'type'              => 'string',
        'sanitize_callback' => 'gatetest_hc_sanitize_weekly_toggle',
        'default'           => 'false',
    ]);
}

/**
 * @param mixed $value Raw option value from the settings form.
 * @return string 'true' or 'false'.
 */
function gatetest_hc_sanitize_weekly_toggle($value) {
    return ($value === 'true' || $value === true || $value === '1' || $value === 1) ? 'true' : 'false';
}

function gatetest_hc_enqueue_assets($hook) {
    if ($hook !== 'tools_page_gatetest-health-check') {
        return;
    }
    wp_enqueue_style(
        'gatetest-hc-admin',
        GATETEST_HC_PLUGIN_URL . 'assets/css/admin.css',
        [],
        GATETEST_HC_VERSION
    );
    wp_enqueue_script(
        'gatetest-hc-admin',
        GATETEST_HC_PLUGIN_URL . 'assets/js/admin.js',
        ['jquery'],
        GATETEST_HC_VERSION,
        true
    );
    // The stored result of the last scan rides along so admin.js can render
    // it on page load — the report container is always present (see
    // gatetest_hc_render_admin_page), so a reload shows the same findings
    // the button did. Every UI string admin.js prints comes from `i18n`.
    $lastResult = get_transient('gatetest_hc_last_result');
    wp_localize_script('gatetest-hc-admin', 'gatetestHc', [
        'ajaxUrl'     => admin_url('admin-ajax.php'),
        'nonce'       => wp_create_nonce('gatetest_hc_scan'),
        'siteUrl'     => home_url(),
        'apiBase'     => GATETEST_HC_API_BASE,
        'checkoutUrl' => GATETEST_HC_API_BASE . '/checkout?tier=wp_health',
        'lastResult'  => is_array($lastResult) ? $lastResult : null,
        'i18n'        => [
            'scanning'         => __('Probing your site… this usually takes 20-60 seconds.', 'gatetest-health-check'),
            /* translators: %1$s: error message */
            'failed'           => __('Scan failed: %1$s', 'gatetest-health-check'),
            'unknownError'     => __('unknown error', 'gatetest-health-check'),
            'networkError'     => __('Network error.', 'gatetest-health-check'),
            /* translators: %1$s: number of errors, %2$s: number of warnings */
            'complete'         => __('Scan complete. Found %1$s error(s), %2$s warning(s).', 'gatetest-health-check'),
            'justNow'          => __('Last scanned just now', 'gatetest-health-check'),
            'noScanYet'        => __('No scan yet. Click "Scan my site now" to run the free health check.', 'gatetest-health-check'),
            'nothingFound'     => __('Nothing major found.', 'gatetest-health-check'),
            'nothingFoundBody' => __('Your site passed every check in the free health check.', 'gatetest-health-check'),
            'untitled'         => __('(untitled)', 'gatetest-health-check'),
            /* translators: %1$s: number of findings not shown in the free health check */
            'hidden'           => __('%1$s more finding(s) are in the full report', 'gatetest-health-check'),
            'fullReport'       => __('The full report is a one-time $19 purchase on gatetest.io — every finding, with step-by-step fix instructions.', 'gatetest-health-check'),
            'getFullReport'    => __('Get the full report ($19, one-time)', 'gatetest-health-check'),
        ],
    ]);
}

function gatetest_hc_render_admin_page() {
    if (!current_user_can('manage_options')) {
        wp_die(esc_html__('You do not have permission to access this page.', 'gatetest-health-check'));
    }

    // Cheap reconciliation: the cron entry follows the saved setting even if
    // the option hooks were skipped (e.g. a value saved unchanged).
    gatetest_hc_sync_weekly_schedule();

    $apiKey       = get_option('gatetest_hc_api_key', '');
    $lastScanAt   = (int) get_option('gatetest_hc_last_scan_at', 0);
    $lastResult   = get_transient('gatetest_hc_last_result');
    $consentShare = get_option('gatetest_hc_consent_url_share', 'false') === 'true';
    ?>
    <div class="wrap gatetest-hc-wrap">
        <h1>
            <span class="gatetest-hc-logo">GateTest</span>
            <?php esc_html_e('Health Check', 'gatetest-health-check'); ?>
        </h1>
        <p class="gatetest-hc-tagline">
            <?php esc_html_e('Audit your site for security, performance, and quality issues. 18 modules, plain-language report.', 'gatetest-health-check'); ?>
        </p>

        <div class="gatetest-hc-panels">
            <div class="gatetest-hc-panel gatetest-hc-panel-primary">
                <h2><?php esc_html_e('Run a scan', 'gatetest-health-check'); ?></h2>
                <p>
                    <?php
                    esc_html_e(
                        'GateTest will probe your public URL from gatetest.io and report any issues found. No source code or credentials are sent.',
                        'gatetest-health-check'
                    );
                    ?>
                </p>
                <p class="gatetest-hc-site-info">
                    <strong><?php esc_html_e('Site URL to scan:', 'gatetest-health-check'); ?></strong>
                    <code><?php echo esc_html(home_url()); ?></code>
                </p>

                <?php // The free health check needs no account and no key — the button is always available. ?>
                <button id="gatetest-hc-run-scan" class="button button-primary button-hero">
                    <?php esc_html_e('Scan my site now', 'gatetest-health-check'); ?>
                </button>
                <div id="gatetest-hc-scan-status" class="gatetest-hc-status"></div>
                <p class="description">
                    <?php
                    printf(
                        /* translators: %s: link to the GateTest WordPress page */
                        esc_html__('Free, no account needed. The full report ($19, one-time) is available at %s.', 'gatetest-health-check'),
                        '<a href="' . esc_url(GATETEST_HC_API_BASE . '/wp') . '" target="_blank" rel="noopener">gatetest.io/wp</a>'
                    );
                    ?>
                </p>
            </div>

            <?php // Always rendered: admin.js fills it on page load (stored result) and after every scan. ?>
            <div class="gatetest-hc-panel">
                <h2><?php esc_html_e('Latest report', 'gatetest-health-check'); ?></h2>
                <p id="gatetest-hc-last-scan-time" class="gatetest-hc-last-scan-time"<?php echo ($lastResult && $lastScanAt) ? '' : ' hidden'; ?>>
                    <?php
                    if ($lastResult && $lastScanAt) {
                        printf(
                            /* translators: %s: human-readable time difference, e.g. "3 hours" */
                            esc_html__('Last scanned %s ago', 'gatetest-health-check'),
                            esc_html(human_time_diff($lastScanAt))
                        );
                    }
                    ?>
                </p>
                <div id="gatetest-hc-report" class="gatetest-hc-report"></div>
            </div>

            <div class="gatetest-hc-panel">
                <h2><?php esc_html_e('Settings', 'gatetest-health-check'); ?></h2>
                <form method="post" action="options.php">
                    <?php settings_fields('gatetest_hc_settings'); ?>
                    <table class="form-table">
                        <tr>
                            <th scope="row">
                                <label for="gatetest_hc_api_key">
                                    <?php esc_html_e('API Key', 'gatetest-health-check'); ?>
                                </label>
                            </th>
                            <td>
                                <input
                                    type="text"
                                    id="gatetest_hc_api_key"
                                    name="gatetest_hc_api_key"
                                    value="<?php echo esc_attr($apiKey); ?>"
                                    class="regular-text"
                                    autocomplete="off"
                                />
                                <p class="description">
                                    <?php
                                    printf(
                                        /* translators: %s: link to the GateTest WordPress page */
                                        esc_html__('Optional — the free health check runs without one. Reserved for the paid full report on gatetest.io; see %s.', 'gatetest-health-check'),
                                        '<a href="' . esc_url(GATETEST_HC_API_BASE . '/wp') . '" target="_blank" rel="noopener">gatetest.io/wp</a>'
                                    );
                                    ?>
                                </p>
                            </td>
                        </tr>
                        <tr>
                            <th scope="row">
                                <label for="gatetest_hc_consent_url_share">
                                    <?php esc_html_e('Weekly auto-scan', 'gatetest-health-check'); ?>
                                </label>
                            </th>
                            <td>
                                <label>
                                    <input
                                        type="checkbox"
                                        id="gatetest_hc_consent_url_share"
                                        name="gatetest_hc_consent_url_share"
                                        value="true"
                                        <?php checked($consentShare); ?>
                                    />
                                    <?php esc_html_e('Run the free health check automatically every Sunday at 3am UTC and keep the latest result on this page.', 'gatetest-health-check'); ?>
                                </label>
                                <p class="description">
                                    <?php esc_html_e('Uses WP-Cron, so it fires on the first site visit after the scheduled time. Off by default; untick to stop.', 'gatetest-health-check'); ?>
                                </p>
                            </td>
                        </tr>
                    </table>
                    <?php submit_button(); ?>
                </form>
            </div>
        </div>

        <p class="gatetest-hc-footer">
            <?php esc_html_e('Powered by the GateTest engine.', 'gatetest-health-check'); ?>
            <a href="<?php echo esc_url(GATETEST_HC_API_BASE); ?>" target="_blank" rel="noopener">gatetest.io</a>
            ·
            <a href="<?php echo esc_url(GATETEST_HC_API_BASE . '/legal/privacy'); ?>" target="_blank" rel="noopener">
                <?php esc_html_e('Privacy policy', 'gatetest-health-check'); ?>
            </a>
        </p>
    </div>
    <?php
}
