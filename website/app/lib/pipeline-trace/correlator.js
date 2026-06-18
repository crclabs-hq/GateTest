'use strict';

/**
 * GateTest Pipeline-Trace Correlator
 *
 * Pure logic — no I/O, no HTTP. Takes four pipeline-stage summaries
 * (source HEAD / latest CI run / latest registered deploy / what the
 * live URL serves) and decides WHERE in the deploy chain the latest
 * update got stuck.
 *
 * Different from triage/correlator.js — that one localises a BUG
 * across source/server/browser. This one localises a deploy SKEW
 * across source → CI → deploy → live → edge.
 *
 * Contract is frozen — orchestrator + UI agents build against it.
 * Do not change `module.exports`.
 */

// ---------- thresholds ----------
const EDGE_CACHE_STALE_MINUTES = 30; // live.ageMinutes above this with matching SHA → edge cache rule

// ---------- regexes (compiled once) ----------
const RE_CI_FAILED_CONCLUSION = /^(failure|cancelled|canceled|timed_out|action_required|startup_failure)$/i;
const RE_CI_PENDING_CONCLUSION = /^(in_progress|queued|waiting|pending|requested)$/i;
const RE_CI_SUCCESS_CONCLUSION = /^(success|neutral|skipped)$/i;
const RE_DEPLOY_FAILED_STATE = /^(error|failure|inactive)$/i;
const RE_DEPLOY_PENDING_STATE = /^(pending|queued|in_progress)$/i;
const RE_AGE_HEADER_HINT = /\bage[:=]\s*(\d{2,})/i;

// ---------- helpers ----------
function isObj(x) {
  return x && typeof x === 'object';
}

function safeStage(x) {
  if (!isObj(x)) {
    return {
      ok: false,
      sha: null,
      shortSha: null,
      timestamp: null,
      ageMinutes: null,
      conclusion: null,
      state: null,
      url: null,
      details: [],
      error: 'missing stage',
    };
  }
  return {
    ok: x.ok === true,
    sha: typeof x.sha === 'string' && x.sha ? x.sha : null,
    shortSha: typeof x.shortSha === 'string' && x.shortSha
      ? x.shortSha
      : (typeof x.sha === 'string' && x.sha ? x.sha.slice(0, 7) : null),
    timestamp: typeof x.timestamp === 'string' ? x.timestamp : null,
    ageMinutes: Number.isFinite(x.ageMinutes) ? x.ageMinutes : null,
    conclusion: typeof x.conclusion === 'string' ? x.conclusion : null,
    state: typeof x.state === 'string' ? x.state : null,
    url: typeof x.url === 'string' ? x.url : null,
    details: Array.isArray(x.details) ? x.details.filter((d) => typeof d === 'string') : [],
    error: typeof x.error === 'string' ? x.error : undefined,
  };
}

// Compare two SHAs on the shorter length. Returns 'equal' | 'different' | 'unknown'.
function compareShas(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
    return 'unknown';
  }
  const len = Math.min(a.length, b.length);
  if (len < 4) return 'unknown'; // not enough to compare safely
  return a.slice(0, len).toLowerCase() === b.slice(0, len).toLowerCase()
    ? 'equal'
    : 'different';
}

function detailMentionsHighAge(stage) {
  for (const d of stage.details || []) {
    const m = RE_AGE_HEADER_HINT.exec(d);
    if (m) {
      const seconds = Number(m[1]);
      if (Number.isFinite(seconds) && seconds >= EDGE_CACHE_STALE_MINUTES * 60) {
        return true;
      }
    }
  }
  return false;
}

function fmtAge(mins) {
  if (!Number.isFinite(mins)) return 'unknown age';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - h * 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  const hr = h - d * 24;
  return hr > 0 ? `${d}d ${hr}h ago` : `${d}d ago`;
}

function shortOf(stage) {
  return stage.shortSha || (stage.sha ? stage.sha.slice(0, 7) : 'unknown');
}

// ---------- stage status ----------
function stageStatus(stage, predecessor) {
  if (!stage.ok || !stage.sha) return 'unknown';
  if (!predecessor || !predecessor.sha) return 'unknown';
  const cmp = compareShas(stage.sha, predecessor.sha);
  if (cmp === 'equal') return 'in-sync';
  if (cmp === 'different') {
    // If predecessor's timestamp is older than this stage's, this stage is "ahead";
    // otherwise it's "behind". Default to "behind" when timestamps unavailable since
    // for ci/deploy/live the natural expectation is they lag behind source.
    const stageTs = stage.timestamp ? Date.parse(stage.timestamp) : NaN;
    const predTs = predecessor.timestamp ? Date.parse(predecessor.timestamp) : NaN;
    if (Number.isFinite(stageTs) && Number.isFinite(predTs)) {
      return stageTs > predTs ? 'ahead' : 'behind';
    }
    return 'behind';
  }
  return 'unknown';
}

function buildStages(source, ci, deploy, live) {
  return [
    { name: 'source', state: source, status: 'in-sync' },
    { name: 'ci', state: ci, status: stageStatus(ci, source), comparedTo: 'source' },
    { name: 'deploy', state: deploy, status: stageStatus(deploy, ci), comparedTo: 'ci' },
    { name: 'live', state: live, status: stageStatus(live, deploy), comparedTo: 'deploy' },
  ];
}

// ---------- trace ----------
function trace(input) {
  const inp = isObj(input) ? input : {};
  const source = safeStage(inp.source);
  const ci = safeStage(inp.ci);
  const deploy = safeStage(inp.deploy);
  const live = safeStage(inp.live);

  const stages = buildStages(source, ci, deploy, live);

  // Rule 1 — no source signal
  if (!source.ok || !source.sha) {
    return {
      verdict: {
        layer: 'unknown',
        confidence: 'low',
        headline: 'Could not read source HEAD — pipeline trace blocked at stage 1',
        rationale: `The source stage failed to return a usable commit SHA (${source.error || 'no signal'}). With no baseline, the correlator cannot compare CI / deploy / live against anything.`,
        recommendedNext: 'Orchestrator needs a valid repo URL and a working GitHub token. Check the repo is public or the PAT has `repo` + `actions:read` scope.',
        divergencePoint: 'no-signal',
      },
      stages,
    };
  }

  const srcShort = shortOf(source);

  // Helpers for the rules below
  const ciSameAsSource = ci.ok && compareShas(ci.sha, source.sha) === 'equal';
  const ciDifferentFromSource = ci.ok && ci.sha && compareShas(ci.sha, source.sha) === 'different';
  const ciFailed = ci.ok && typeof ci.conclusion === 'string' && RE_CI_FAILED_CONCLUSION.test(ci.conclusion);
  const ciPending = ci.ok && (
    ci.conclusion === null ||
    ci.conclusion === undefined ||
    (typeof ci.conclusion === 'string' && RE_CI_PENDING_CONCLUSION.test(ci.conclusion))
  );
  const ciSucceeded = ci.ok && typeof ci.conclusion === 'string' && RE_CI_SUCCESS_CONCLUSION.test(ci.conclusion);

  // Rule 2 — CI hasn't run on HEAD (different SHA from source)
  if (ciDifferentFromSource) {
    const ciShort = shortOf(ci);
    const ageStr = ci.ageMinutes != null ? fmtAge(ci.ageMinutes) : 'unknown age';
    return {
      verdict: {
        layer: 'ci',
        confidence: 'high',
        headline: `CI hasn't built the latest commit yet (HEAD ${srcShort}, last CI ran on ${ciShort})`,
        rationale: `Source default branch is at ${srcShort}, but the latest CI run was against ${ciShort} (${ageStr}). The deploy pipeline can't advance past CI until it picks up HEAD.`,
        recommendedNext: 'Wait for the workflow to finish, OR re-trigger CI on the default branch.',
        divergencePoint: 'ci-not-built',
      },
      stages,
    };
  }

  // Rule 3 — CI failed on HEAD
  if (ciSameAsSource && ciFailed) {
    return {
      verdict: {
        layer: 'ci',
        confidence: 'high',
        headline: `CI failed on HEAD (${srcShort}, conclusion: ${ci.conclusion})`,
        rationale: `CI ran on the latest commit ${srcShort} and ended with conclusion "${ci.conclusion}". Nothing downstream will deploy until the workflow succeeds.`,
        recommendedNext: `Open the workflow run${ci.url ? ` (${ci.url})` : ''} and fix the failure — nothing will deploy until CI passes.`,
        divergencePoint: 'ci-failed',
      },
      stages,
    };
  }

  // Rule 4 — CI still running on HEAD
  if (ciSameAsSource && ciPending) {
    const ageStr = ci.ageMinutes != null ? fmtAge(ci.ageMinutes) : 'just now';
    return {
      verdict: {
        layer: 'ci',
        confidence: 'medium',
        headline: `CI is still running on HEAD (${srcShort})`,
        rationale: `The workflow on ${srcShort} is currently "${ci.conclusion || 'in_progress'}" (started ${ageStr}). Deploy stage can't pick up the build until CI completes.`,
        recommendedNext: `Wait for the workflow to complete (started ${ageStr}).`,
        divergencePoint: 'ci-not-built',
      },
      stages,
    };
  }

  // Rule 5 — Deploy hasn't picked up CI (ci passed on HEAD, deploy is behind)
  const deploySameAsCi = deploy.ok && ci.ok && compareShas(deploy.sha, ci.sha) === 'equal';
  const deployDifferentFromCi = deploy.ok && deploy.sha && ci.ok && ci.sha && compareShas(deploy.sha, ci.sha) === 'different';
  if (ciSameAsSource && ciSucceeded && deployDifferentFromCi) {
    const ciShort = shortOf(ci);
    const deployShort = shortOf(deploy);
    const ciAge = ci.ageMinutes != null ? fmtAge(ci.ageMinutes) : 'recently';
    return {
      verdict: {
        layer: 'deploy',
        confidence: 'high',
        headline: `Last deploy is behind CI — deploy ${deployShort}, CI succeeded on ${ciShort} ${ciAge}`,
        rationale: `CI succeeded on ${ciShort} (matches source HEAD), but the latest registered deploy is for an older commit ${deployShort}. The host integration isn't picking up green builds.`,
        recommendedNext: 'Check the Vercel/host integration on the GitHub repo; retry the deploy if the integration looks broken.',
        divergencePoint: 'deploy-behind',
      },
      stages,
    };
  }

  // Rule 6 — Deploy errored on HEAD
  const deploySameAsSource = deploy.ok && deploy.sha && compareShas(deploy.sha, source.sha) === 'equal';
  const deployFailed = deploy.ok && typeof deploy.state === 'string' && RE_DEPLOY_FAILED_STATE.test(deploy.state);
  if (deploySameAsSource && deployFailed) {
    return {
      verdict: {
        layer: 'deploy',
        confidence: 'high',
        headline: `Latest deploy failed (state: ${deploy.state})`,
        rationale: `A deploy for HEAD ${srcShort} was registered but its state is "${deploy.state}". The host attempted to ship the latest commit and the deploy did not succeed.`,
        recommendedNext: `Open the deploy log${deploy.url ? ` (${deploy.url})` : ''} on Vercel/host to see the failure reason.`,
        divergencePoint: 'deploy-failed',
      },
      stages,
    };
  }

  // Rule 7 — Live URL embeds an older SHA than deploy
  const liveDifferentFromDeploy = live.ok && live.sha && deploy.ok && deploy.sha && compareShas(live.sha, deploy.sha) === 'different';
  if (deploySameAsCi && liveDifferentFromDeploy) {
    const liveShort = shortOf(live);
    const deployShort = shortOf(deploy);
    const deployAge = deploy.ageMinutes != null ? fmtAge(deploy.ageMinutes) : 'recently';
    return {
      verdict: {
        layer: 'live',
        confidence: 'high',
        headline: `Live URL is still serving deploy ${liveShort}, but newer deploy ${deployShort} succeeded ${deployAge}`,
        rationale: `The live URL response embeds commit ${liveShort}, while the host registered a newer successful deploy ${deployShort} ${deployAge}. The deploy-to-edge propagation hasn't completed.`,
        recommendedNext: 'If a CDN sits in front of the host, purge it; otherwise the deploy-to-edge propagation hasn\'t finished — give it a few minutes and reprobe.',
        divergencePoint: 'live-stale',
      },
      stages,
    };
  }

  // Rule 8 — Live URL stale via CDN age (matching SHA but cache too old)
  const liveSameAsDeploy = live.ok && live.sha && deploy.ok && deploy.sha && compareShas(live.sha, deploy.sha) === 'equal';
  const liveLooksStale = liveSameAsDeploy && (
    (Number.isFinite(live.ageMinutes) && live.ageMinutes > EDGE_CACHE_STALE_MINUTES) ||
    detailMentionsHighAge(live)
  );
  if (liveLooksStale) {
    const ageStr = live.ageMinutes != null ? `${Math.round(live.ageMinutes)} min` : 'a long time';
    return {
      verdict: {
        layer: 'edge',
        confidence: 'medium',
        headline: `Edge cache is serving a stale response (age: ${ageStr})`,
        rationale: `The live URL embeds the latest deploy SHA ${shortOf(live)}, so the deploy itself shipped successfully, but the response is being served from cache with a high \`age\` (${ageStr}). Behaviour will look "frozen" to end users until the cache rolls.`,
        recommendedNext: 'Hit the live URL with a hard refresh / bypass cache, or wait for the TTL to expire.',
        divergencePoint: 'edge-cache',
      },
      stages,
    };
  }

  // Rule 9 — all four in sync
  const allSync = source.sha
    && compareShas(source.sha, ci.sha) === 'equal'
    && compareShas(ci.sha, deploy.sha) === 'equal'
    && compareShas(deploy.sha, live.sha) === 'equal';
  if (allSync) {
    return {
      verdict: {
        layer: 'synced',
        confidence: 'high',
        headline: `Pipeline is in sync — source, CI, deploy, and live all on ${srcShort}`,
        rationale: 'All four pipeline stages report the same commit SHA. The deploy chain is healthy and is currently serving the latest source HEAD.',
        recommendedNext: 'If updates are still missing, the issue is application-level (cache layer in the app, stale data, etc.), not the deploy chain.',
        divergencePoint: 'in-sync',
      },
      stages,
    };
  }

  // Rule 10 — fallback
  const seen = [
    `source ${source.sha ? shortOf(source) : 'n/a'}${source.ageMinutes != null ? ` (${fmtAge(source.ageMinutes)})` : ''}`,
    `ci ${ci.ok && ci.sha ? shortOf(ci) : 'n/a'}${ci.ageMinutes != null ? ` (${fmtAge(ci.ageMinutes)})` : ''}`,
    `deploy ${deploy.ok && deploy.sha ? shortOf(deploy) : 'n/a'}${deploy.ageMinutes != null ? ` (${fmtAge(deploy.ageMinutes)})` : ''}`,
    `live ${live.ok && live.sha ? shortOf(live) : 'n/a'}${live.ageMinutes != null ? ` (${fmtAge(live.ageMinutes)})` : ''}`,
  ].join(', ');

  return {
    verdict: {
      layer: 'unknown',
      confidence: 'low',
      headline: 'Pipeline trace could not localise the divergence point',
      rationale: `None of the correlator rules matched the observed pattern (${seen}). Operator review required — at least one stage's signal is incomplete or contradictory.`,
      recommendedNext: 'Inspect the per-stage table below and decide manually which stage to investigate first.',
      divergencePoint: 'no-signal',
    },
    stages,
  };
}

// ---------- renderTraceMarkdown ----------
function renderTraceMarkdown(verdict, stages) {
  const v = verdict || {};
  const list = Array.isArray(stages) ? stages : [];
  const out = [];

  out.push(`## ${v.headline || 'Pipeline trace verdict'}`);
  out.push('');
  out.push(`**Divergence point:** \`${v.divergencePoint || 'no-signal'}\` · **Confidence:** \`${v.confidence || 'low'}\` · **Layer:** \`${v.layer || 'unknown'}\``);
  out.push('');
  if (v.rationale) {
    out.push(v.rationale);
    out.push('');
  }

  out.push('| Stage | SHA | Age | Status | Conclusion / State |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const s of list) {
    const state = s.state || {};
    const sha = state.shortSha || (state.sha ? state.sha.slice(0, 7) : '—');
    const age = state.ageMinutes != null ? fmtAge(state.ageMinutes) : '—';
    const status = s.status || 'unknown';
    const verdictCol = state.conclusion || state.state || (state.ok ? 'ok' : (state.error || 'failed'));
    out.push(`| ${s.name} | \`${sha}\` | ${age} | \`${status}\` | ${verdictCol} |`);
  }
  out.push('');

  if (v.recommendedNext) {
    out.push(`**Recommended next:** ${v.recommendedNext}`);
  }

  return out.join('\n');
}

module.exports = { trace, compareShas, renderTraceMarkdown };
