# npm publish — Craig's checklist

Verbatim what to type, in order, the first time we publish.

## Pre-flight (run once)

```bash
# Confirm logged in
npm whoami

# If you see "ENEEDAUTH":
npm login
# (npm will open a browser. Use the @gatetest account, or whichever
# account is the canonical maintainer.)

# Sanity-check the tarball BEFORE publishing
cd /path/to/gatetest
npm publish --dry-run
```

Expected dry-run output:

- `name: gatetest`
- `version: 1.41.0`
- `package size: ~290 kB`
- `total files: ~100`
- Files listed: `bin/`, `src/`, `docs/MCP.md`, `README.md`, `LICENSE`,
  `CHANGELOG.md`, `package.json`. **No `tests/`, no `website/`, no
  `.gatetest/`, no `node_modules/`, no `.git/`.**

If anything looks off, STOP and ask Claude. Don't push a bad first publish —
unpublishing within 72h works, after 72h it requires npm support intervention.

## The publish

```bash
npm publish --access public
```

Watch for:
- `+ gatetest@1.41.0` — success
- A few seconds of provenance-attestation noise (fine, this is npm's new
  default and a good thing)

## Post-publish verification

From a different machine (or `npm uninstall -g gatetest && npm cache clean
--force` locally):

```bash
# Install fresh from the registry
npm install -g gatetest

# Confirm version
gatetest --version
# expected: GateTest v1.41.0

# Confirm modules load
gatetest --list | head -20
# expected: ~67 modules listed

# Confirm MCP entry point
which gatetest-mcp
# expected: <prefix>/bin/gatetest-mcp

# Confirm the MCP server handshake
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  | gatetest mcp
# expected: a JSON-RPC response with serverInfo.name = "gatetest"
```

If ANY of those fail, take it down with:

```bash
npm unpublish gatetest@1.41.0
# (only works within 72h of publish, and only if no other package depends on it)
```

…then fix and re-publish.

## After verification — the Show HN moment

Only NOW post to Hacker News. The post body says
`npm install -g gatetest` and if step 4 above didn't return v1.41.0, the
top comment will be "doesn't work" within ten minutes.

## 2FA reminder

npm requires 2FA for new package publishes. Have your authenticator ready.
If `npm publish` errors with `EOTP`, copy the code from your authenticator
and paste it when prompted.

## Provenance (optional but recommended)

Once we're publishing from CI (e.g. a GitHub Action triggered by a tag),
add `--provenance` to the publish command. It signs the publish with the
CI run's identity, so consumers can verify it actually came from our
GitHub repo. Not needed on the first manual publish.
