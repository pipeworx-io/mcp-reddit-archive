# @pipeworx/reddit-archive

Historical Reddit post and comment search, and subreddit activity over time,
going back to Reddit's early years — reaching far further back than the live
Reddit API, which only exposes a recent, unfiltered window.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1779+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `reddit_history_posts(subreddit, query?, after?, before?, limit?, sort?)` — posts from one subreddit, filtered by keyword and/or date range. Returns id, title, author, created_utc (ISO), score, num_comments, permalink.
- `reddit_history_comments(subreddit?, link_id?, query?, after?, before?, limit?, sort?)` — comments scoped to a subreddit and/or a specific post, filtered by keyword and/or date range. Requires at least one of `subreddit` or `link_id`. Returns id, author, created_utc (ISO), score, body, link_id, permalink.
- `subreddit_activity(subreddit, after?, before?)` — subreddit identity (subscriber count, creation date, all-time post/comment totals, earliest indexed post/comment) plus monthly post/comment counts within a date window (default: the last 12 months).

## Auth

Keyless.

## Data sources

- Arctic Shift (the `arctic_shift` open-source project by Arthur Heitmann), a
  historical Reddit archive — independently re-crawled and republished public
  Reddit posts, comments and subreddit metadata, covering years the live
  Reddit API no longer serves. No uptime guarantee is published.

## Other notes

- **Silent-zero handling.** The upstream answers an empty result with the
  same shape whether a subreddit genuinely has nothing matching a filter OR
  the subreddit was never indexed at all — there is no dedicated "not found"
  status for that case. On an empty result this pack makes one extra lookup
  call against the upstream's own subreddit index to tell the two apart:
  an unindexed/nonexistent subreddit throws a loud error; a real subreddit
  with a genuinely empty window returns an explicit `verified_empty: true`
  result instead of a bare `[]`. `reddit_history_comments` does the same
  check against the post id when scoped by `link_id` instead of `subreddit`.
- **Transient 422s and 429s.** The upstream occasionally answers a well-formed
  query with HTTP 422 ("Timeout. Maybe slow down a bit") or HTTP 429
  (rate-limited) — observed live to recur 2-3 times in a row under load,
  unrelated to the query itself. This pack retries both, honouring `Retry-After`
  on a 429 when the upstream sends one, within a 20s wall-clock retry budget
  (not just a fixed attempt count) before surfacing it as a real error.
- **Monthly bucket labelling (`subreddit_activity`).** The upstream's
  aggregate endpoint buckets by local calendar month but reports each
  bucket's timestamp converted to UTC, which lands on the last hour of the
  PRECEDING UTC day (e.g. a January bucket arrives as
  `"2019-12-31T23:00:00.000Z"`). This pack rolls that timestamp forward to
  the next UTC midnight before reading the month, so `monthly_posts` /
  `monthly_comments` are labelled by the month they actually cover.
- **Politeness.** This pack keeps outbound calls to roughly one per second —
  tools that need more than one upstream call internally (the empty-result
  existence check; `subreddit_activity`'s three calls) space them out rather
  than firing in a burst.
- **No per-author aggregation.** `reddit_history_comments` accepts no author
  filter and this pack does not roll any tool's results up by author — only
  the raw, publicly-served posts/comments a filter matches.
- **Date format.** `after`/`before` take ISO dates like `"2019-01-01"`.
- IDs come back bare (e.g. `"ei9204"`, not `"t3_ei9204"`); `link_id` accepts
  either form.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "reddit-archive": {
      "url": "https://gateway.pipeworx.io/reddit-archive/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/reddit-archive/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1779+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/reddit_history_posts \
  -H 'Content-Type: application/json' \
  -d '{"subreddit":"datasets","before":"2020-01-01","after":"2019-01-01","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/reddit_history_posts`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "reddit-archive": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-reddit-archive"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-reddit-archive
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Reddit Archive data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
