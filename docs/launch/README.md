# Launch playbook

Drop-ready copy for every distribution channel. **Nothing here is auto-posted.**
Craig reviews each piece, then posts under his account.

| File | Channel | Status |
|------|---------|--------|
| `hn-show.md` | Hacker News (Show HN) | DRAFT — Craig review |
| `awesome-mcp-servers.md` | PR to `punkpeye/awesome-mcp-servers` (Cursor folks maintain it) | DRAFT |
| `producthunt.md` | Product Hunt launch copy | DRAFT |
| `claude-code-mcp-registry.md` | Anthropic's MCP registry submission | DRAFT |
| `cursor-mcp-docs.md` | PR to Cursor's docs `mcp.json` examples | DRAFT |
| `npm-publish-checklist.md` | What Craig types to publish `gatetest` to npm | READY |

## Order of operations on launch day

1. **Publish to npm** (`npm-publish-checklist.md`). This MUST happen first —
   every other channel says "npm install -g gatetest" and if the package
   isn't there it dies on contact.
2. **Confirm the install works** — `npx gatetest@latest --version` from a
   fresh machine returns `1.41.0`.
3. **Post the Show HN** — `hn-show.md`. Anchor of the launch.
4. **Submit the awesome-mcp-servers PR** — within an hour of Show HN going up.
5. **Product Hunt** — same day, separate audience.
6. **Cursor docs PR** — passive, no time pressure.
7. **Claude Code MCP registry** — passive, no time pressure.

## Anti-failure-modes

- Don't post until npm publish is confirmed.
- Don't post on a Friday afternoon (HN front page churn is highest Mon-Wed
  morning US/PT).
- Have a private staging URL ready in case gatetest.ai gets hugged to death.
- Watch the comments for the first 4 hours — be present, respond fast,
  upvote good questions.
