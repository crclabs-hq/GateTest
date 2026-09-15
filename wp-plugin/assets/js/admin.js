/**
 * GateTest Health Check — admin page JS.
 * Handles the "Scan my site now" button + report rendering.
 *
 * Every user-visible string comes from window.gatetestHc.i18n (set by
 * wp_localize_script in includes/admin-page.php) so it is translatable.
 * The stored result of the last scan arrives the same way
 * (window.gatetestHc.lastResult) and is rendered on page load — the
 * report container is always present, so a first scan and a reload both
 * show findings.
 */
(function ($) {
    'use strict';

    $(function () {
        var config = window.gatetestHc || {};
        var i18n = config.i18n || {};
        var $btn = $('#gatetest-hc-run-scan');
        var $status = $('#gatetest-hc-scan-status');
        var $report = $('#gatetest-hc-report');
        var $lastScanTime = $('#gatetest-hc-last-scan-time');

        if (!$report.length) {
            return;
        }

        function t(key, fallback) {
            return typeof i18n[key] === 'string' ? i18n[key] : fallback;
        }

        // sprintf-lite: replaces %1$s, %2$s … with the given arguments.
        function format(template, args) {
            return String(template).replace(/%(\d+)\$s/g, function (_, n) {
                var v = args[Number(n) - 1];
                return v == null ? '' : String(v);
            });
        }

        function escapeHtml(s) {
            if (typeof s !== 'string') {
                s = String(s == null ? '' : s);
            }
            return s
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function setStatus(state, text) {
            $status.attr('class', 'gatetest-hc-status ' + state).text(text);
        }

        function checkoutUrl(data) {
            var base = typeof config.apiBase === 'string' ? config.apiBase.replace(/\/$/, '') : '';
            var cta = data && data.paywall && typeof data.paywall.ctaUrl === 'string' ? data.paywall.ctaUrl : '';
            if (cta.charAt(0) === '/' && base) {
                return base + cta;
            }
            if (/^https:\/\//.test(cta)) {
                return cta;
            }
            return config.checkoutUrl || '';
        }

        function renderReport(data, announce) {
            var findings = (data && Array.isArray(data.findings)) ? data.findings : [];
            var summary = {
                errors: (data && data.errorCount) || 0,
                warnings: (data && data.warningCount) || 0,
                total: (data && data.totalFindings) || findings.length
            };

            if (announce) {
                setStatus('is-success', format(t('complete', 'Scan complete. Found %1$s error(s), %2$s warning(s).'), [summary.errors, summary.warnings]));
            }

            if (findings.length === 0) {
                $report.html('<p><strong>' + escapeHtml(t('nothingFound', 'Nothing major found.')) + '</strong> ' +
                    escapeHtml(t('nothingFoundBody', 'Your site passed every check in the free health check.')) + '</p>');
                return;
            }

            var html = '';
            findings.forEach(function (f) {
                var severity = String(f.severity || 'info').replace(/[^a-z]/g, '') || 'info';
                html += '<div class="gatetest-hc-finding severity-' + severity + '">';
                html += '<div class="gatetest-hc-finding-title">' + escapeHtml(f.title || t('untitled', '(untitled)')) + '</div>';
                html += '<div class="gatetest-hc-finding-body">' + escapeHtml(f.body || '') + '</div>';
                html += '</div>';
            });

            if (data.preview && data.paywall && data.paywall.remainingCount > 0) {
                var url = checkoutUrl(data);
                html += '<div class="gatetest-hc-paywall">';
                html += '<h3>' + escapeHtml(format(t('hidden', '%1$s more finding(s) are in the full report'), [data.paywall.remainingCount])) + '</h3>';
                html += '<p>' + escapeHtml(t('fullReport', 'The full report is a one-time $19 purchase on gatetest.io — every finding, with step-by-step fix instructions.')) + '</p>';
                if (url) {
                    html += '<p><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" class="button button-primary">' +
                        escapeHtml(t('getFullReport', 'Get the full report ($19, one-time)')) + '</a></p>';
                }
                html += '</div>';
            }

            $report.html(html);
        }

        // Page load: show whatever the last scan (button or weekly) stored.
        if (config.lastResult && typeof config.lastResult === 'object') {
            renderReport(config.lastResult, false);
        } else {
            $report.html('<p class="gatetest-hc-empty">' + escapeHtml(t('noScanYet', 'No scan yet. Click "Scan my site now" to run the free health check.')) + '</p>');
        }

        if (!$btn.length) {
            return;
        }

        $btn.on('click', function (e) {
            e.preventDefault();
            $btn.prop('disabled', true);
            setStatus('is-scanning', t('scanning', 'Probing your site… this usually takes 20-60 seconds.'));

            $.post(config.ajaxUrl, {
                action: 'gatetest_hc_run_scan',
                nonce: config.nonce
            })
                .done(function (response) {
                    $btn.prop('disabled', false);
                    if (!response || !response.success) {
                        var message = response && response.data && response.data.message
                            ? response.data.message
                            : t('unknownError', 'unknown error');
                        setStatus('is-error', format(t('failed', 'Scan failed: %1$s'), [message]));
                        return;
                    }
                    $lastScanTime.text(t('justNow', 'Last scanned just now')).show();
                    renderReport(response.data, true);
                })
                .fail(function (xhr) {
                    $btn.prop('disabled', false);
                    var message = t('networkError', 'Network error.');
                    if (xhr && xhr.responseJSON && xhr.responseJSON.data && xhr.responseJSON.data.message) {
                        message = xhr.responseJSON.data.message;
                    }
                    setStatus('is-error', format(t('failed', 'Scan failed: %1$s'), [message]));
                });
        });
    });
})(jQuery);
