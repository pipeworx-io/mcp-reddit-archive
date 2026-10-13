interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Reddit Archive — historical Reddit post and comment search, and subreddit
 * activity over time, sourced from the Arctic Shift archive. Keyless.
 *
 * Why this exists: the `reddit` pack reads Reddit's own RSS feeds, which cap
 * any listing at Reddit's own live-search window (recent posts only, no
 * reliable date filtering). Pushshift — the old historical-archive project —
 * shut down. The r/datasets community keeps asking for exactly this (fleet
 * #2956). Arctic Shift independently re-crawls and republishes Reddit's
 * historical data back to ~2005, with subreddit/author/date/keyword filters
 * the live API never offered.
 *
 * hosting-claims-ok: this pack calls Arctic Shift's live API per request and
 * returns its answer — we hold no copy of Reddit's data. Every description
 * below names Arctic Shift as the source of what it returns.
 *
 * Personal-data note (CLAUDE.md "What we will source"): these are posts and
 * comments Reddit itself serves to anyone, unauthenticated. Per the task that
 * commissioned this pack, there is deliberately NO per-author aggregation
 * tool here — `reddit_history_comments` can filter BY an author only insofar
 * as Arctic Shift's own `author` query parameter does, but nothing in this
 * pack rolls a user's activity up into a profile.
 *
 * Politeness: Arctic Shift asks for <=1 req/s and has no uptime guarantee.
 * Tools that need more than one upstream call (the empty-result existence
 * check, subreddit_activity's three calls) space them out with `politeDelay`.
 * Arctic Shift also answers a well-formed query with an occasional transient
 * HTTP 422 ("Timeout. Maybe slow down a bit") or 429 (rate-limited) —
 * confirmed live 2026-10-12/13, unrelated to the query itself and sometimes
 * 2-3 in a row. `arcGet` retries both within a wall-clock budget (not just a
 * fixed attempt count), honouring Retry-After on a 429 when present.
 *
 * Tools:
 * - reddit_history_posts:    posts/search — subreddit, keyword, date range
 * - reddit_history_comments: comments/search — subreddit and/or post, keyword, date range
 * - subreddit_activity:      subreddit identity (subscribers, all-time totals)
 *                            plus monthly post/comment volume in a window
 *
 * Silent-zero handling (docs/silent-zero-policy.md): Arctic Shift returns
 * `{"data":[]}` with HTTP 200 for BOTH "this subreddit doesn't exist" and
 * "this subreddit exists but nothing matched your filter" — identical shape,
 * very different facts. On an empty result this pack makes ONE extra call to
 * `/api/subreddits/search?subreddit=<name>` (which Arctic Shift maintains as
 * an index of subreddits it has actually seen) to tell the two apart: unknown
 * subreddit throws a loud error; a verified-real subreddit with a genuinely
 * empty window returns an explicit `verified_empty: true` result rather than
 * a bare `[]`.
 */


const BASE = 'https://arctic-shift.photon-reddit.com/api';
const UA = 'pipeworx-mcp-reddit-archive/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Arctic Shift');
}

function politeDelay(ms = 1100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ArcList<T> {
  data: T[] | null;
  error?: string;
}

/** Retry-After can be either delay-seconds or an HTTP-date (RFC 9110 §10.2.3).
 *  Returns the wait in ms, or null if the header is absent/unparseable. */
export function parseRetryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

// Retries are bounded by a WALL-CLOCK budget, not just an attempt count — a
// fixed attempt count still lets an upstream that respects Retry-After with a
// long wait (or several short ones) run past whatever deadline the gateway or
// an MCP client is holding this call to. 5s cap per individual wait (even one
// Arctic Shift itself asks for longer), 20s total retry budget per upstream
// call (fleet #2956 follow-up, 2026-10-13: a bare 25s-per-attempt fetch
// timeout with no overall retry ceiling let one subreddit_activity call run
// 45s end to end).
const MAX_BACKOFF_MS = 5_000;
const MAX_RETRY_BUDGET_MS = 20_000;

/** GET a path on Arctic Shift, retrying a transient 422 ("Timeout. Maybe
 *  slow down a bit") or 429 (rate-limited — observed live 2026-10-13, twice
 *  in a row) with backoff, honouring Retry-After on a 429 when present, then
 *  parsing the body. Retries stop once MAX_RETRY_BUDGET_MS has elapsed, not
 *  just after a fixed attempt count. */
async function arcGet<T>(path: string, params: URLSearchParams, label: string): Promise<ArcList<T>> {
  const url = `${BASE}${path}?${params.toString()}`;
  const retryStart = Date.now();
  let res = await pwFetch(url);
  let attempt = 0;
  while ((res.status === 422 || res.status === 429) && Date.now() - retryStart < MAX_RETRY_BUDGET_MS) {
    attempt += 1;
    const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res) : null;
    const backoffMs = Math.min(retryAfterMs ?? 1200 * attempt, MAX_BACKOFF_MS);
    await politeDelay(backoffMs);
    res = await pwFetch(url);
  }
  if (!res.ok) throw await httpError(res, `Arctic Shift ${label}`);
  return parseJson<ArcList<T>>(res, `Arctic Shift ${label}`);
}

function normalizeSubreddit(v: unknown): string {
  return String(v ?? '').trim().replace(/^\/?r\//i, '');
}

function normalizePostId(v: unknown): string {
  return String(v ?? '').trim().replace(/^t3_/i, '');
}

function clampLimit(v: unknown, def = 25, max = 100): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

function iso(unixSeconds: unknown): string | null {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

/**
 * Arctic Shift's `/search/aggregate?frequency=month` buckets by LOCAL
 * calendar month (the server appears to run on Europe/Berlin — CET/CEST),
 * then reports each bucket's start as that local midnight CONVERTED to UTC.
 * Local midnight is ahead of UTC, so the UTC timestamp lands on the LAST
 * hour of the PREVIOUS UTC calendar day: a January bucket is reported as
 * "2019-12-31T23:00:00.000Z" in winter (CET, UTC+1) and "...T22:00:00.000Z"
 * in summer (CEST, UTC+2) — confirmed live 2026-10-13 against
 * /posts/search/aggregate for r/askhistorians, after=2020-01-01&before=
 * 2020-03-01: `[{"created_utc":"2019-12-31T23:00:00.000Z","count":"5076"},
 * {"created_utc":"2020-01-31T23:00:00.000Z","count":"5059"}]` for what is
 * unambiguously the Jan/Feb 2020 window.
 *
 * Reading the month straight off that UTC string (`.slice(0, 7)`) therefore
 * names the PRECEDING month for every bucket — the Jan bucket reads "2019-12",
 * the Feb bucket reads "2020-01" (fleet #2956 follow-up, caught in the
 * post-deploy probe). Fix: ceiling the timestamp up to the next UTC midnight
 * before reading the month. A bucket that is already exactly at a UTC
 * midnight (offset 0, e.g. a UTC-hosted source) is left alone; one that
 * isn't rolls forward to the month it actually started. Safe for any
 * POSITIVE local-UTC offset up to 24h, which covers CET/CEST.
 */
export function aggregateBucketMonth(createdUtcIso: string): string | null {
  const ms = Date.parse(createdUtcIso);
  if (!Number.isFinite(ms)) return null;
  const DAY_MS = 86_400_000;
  const ceiledMs = Math.ceil(ms / DAY_MS) * DAY_MS;
  return new Date(ceiledMs).toISOString().slice(0, 7);
}

interface RawPost {
  id: string;
  title: string | null;
  author: string | null;
  subreddit: string | null;
  created_utc: number;
  score: number | null;
  num_comments: number | null;
  permalink: string | null;
  selftext: string | null;
  url: string | null;
  over_18: boolean | null;
}

interface RawComment {
  id: string;
  author: string | null;
  subreddit: string | null;
  created_utc: number;
  score: number | null;
  body: string | null;
  link_id: string | null;
  parent_id: string | null;
  permalink: string | null;
}

interface RawSubreddit {
  display_name: string;
  subscribers: number | null;
  created_utc: number | null;
  subreddit_type: string | null;
  _meta?: {
    num_posts?: number;
    num_comments?: number;
    earliest_post?: number;
    earliest_comment?: number;
  };
}

function normalizePost(p: RawPost) {
  return {
    id: p.id,
    title: p.title,
    author: p.author,
    subreddit: p.subreddit,
    created_utc: iso(p.created_utc),
    score: p.score,
    num_comments: p.num_comments,
    permalink: p.permalink ? `https://www.reddit.com${p.permalink}` : null,
    url: p.url ?? null,
    selftext: p.selftext ?? null,
    over_18: p.over_18 ?? null,
  };
}

function normalizeComment(c: RawComment) {
  return {
    id: c.id,
    author: c.author,
    subreddit: c.subreddit,
    created_utc: iso(c.created_utc),
    score: c.score,
    body: c.body,
    link_id: c.link_id ? c.link_id.replace(/^t3_/i, '') : null,
    permalink: c.permalink ? `https://www.reddit.com${c.permalink}` : null,
  };
}

/** Looks up a subreddit in Arctic Shift's own index. Distinguishes "doesn't
 *  exist" from "exists but a search within it found nothing" — the whole
 *  point of this call; see the silent-zero note at the top of the file. */
async function lookupSubreddit(subreddit: string): Promise<RawSubreddit | null> {
  const params = new URLSearchParams({ subreddit });
  const json = await arcGet<RawSubreddit>('/subreddits/search', params, 'subreddit lookup');
  return json.data?.[0] ?? null;
}

async function postExists(postId: string): Promise<boolean> {
  const params = new URLSearchParams({ ids: postId });
  const json = await arcGet<{ id: string }>('/posts/ids', params, 'post lookup');
  return (json.data?.length ?? 0) > 0;
}

function monthsAgoIso(n: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

const tools: McpToolExport['tools'] = [
  {
    name: 'reddit_history_posts',
    description:
      'Historical Reddit POSTS from one subreddit, back to ~2005 — via the Arctic Shift archive, not the live Reddit API (which the `reddit` pack uses and which only reaches ~1,000 recent results with no reliable date filter). PREFER for "Reddit posts about X in/before <year>", "what did r/<sub> post about Y historically", or any request the live reddit pack cannot date-filter. Filter by date range (after/before, ISO dates like "2019-01-01") and/or keyword (query, matched against title+body). Returns id, title, author, created_utc (ISO), score, num_comments, permalink. A subreddit Arctic Shift has never indexed is reported as a loud error, never a silent empty list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subreddit: { type: 'string', description: 'Subreddit name without the r/ prefix, e.g. "datasets".' },
        query: { type: 'string', description: 'Optional keyword — matched against post title and body text.' },
        after: { type: 'string', description: 'Optional ISO date (e.g. "2019-01-01") — only posts created on/after this date.' },
        before: { type: 'string', description: 'Optional ISO date (e.g. "2020-01-01") — only posts created before this date.' },
        limit: { type: 'number', description: 'Max posts to return (default 25, max 100).' },
        sort: { type: 'string', description: '"asc" or "desc" by post date (default "desc", newest first).' },
      },
      required: ['subreddit'],
    },
  },
  {
    name: 'reddit_history_comments',
    description:
      'Historical Reddit COMMENTS via the Arctic Shift archive — scope to a subreddit, a specific post (link_id), or both; requires at least one. Optionally filter by keyword (query, matched against comment body) and date range (after/before, ISO dates). Returns id, author, created_utc (ISO), score, body, link_id, permalink. No per-author aggregation is provided by this pack — results are the raw comments Arctic Shift\'s filters match, nothing rolled up into a user profile.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subreddit: { type: 'string', description: 'Subreddit name without the r/ prefix, e.g. "datasets". Provide this and/or link_id.' },
        link_id: { type: 'string', description: 'Reddit post ID to fetch comments under, e.g. "ei9204" (with or without the "t3_" prefix). Provide this and/or subreddit.' },
        query: { type: 'string', description: 'Optional keyword — matched against comment body text.' },
        after: { type: 'string', description: 'Optional ISO date (e.g. "2019-01-01") — only comments created on/after this date.' },
        before: { type: 'string', description: 'Optional ISO date (e.g. "2020-01-01") — only comments created before this date.' },
        limit: { type: 'number', description: 'Max comments to return (default 25, max 100).' },
        sort: { type: 'string', description: '"asc" or "desc" by comment date (default "desc", newest first).' },
      },
      required: [],
    },
  },
  {
    name: 'subreddit_activity',
    description:
      'Reddit subreddit identity and activity over time, via the Arctic Shift archive: subscriber count, subreddit creation date, all-time post/comment totals, earliest indexed post/comment, and monthly post/comment counts within a date window (default: the last 12 months). A subreddit Arctic Shift has never indexed is reported as a loud not-found error, never a silent empty result.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subreddit: { type: 'string', description: 'Subreddit name without the r/ prefix, e.g. "datasets".' },
        after: { type: 'string', description: 'Optional ISO date (e.g. "2024-01-01") for the monthly-activity window; default is 12 months ago.' },
        before: { type: 'string', description: 'Optional ISO date (e.g. "2025-01-01") for the monthly-activity window; default is today.' },
      },
      required: ['subreddit'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'reddit_history_posts': {
      const subreddit = normalizeSubreddit(args.subreddit);
      if (!subreddit) throw new Error('subreddit is required (e.g. "datasets", without the r/ prefix).');
      const limit = clampLimit(args.limit);
      const sort = args.sort === 'asc' ? 'asc' : 'desc';
      const query = args.query ? String(args.query).trim() : '';
      const after = args.after ? String(args.after).trim() : '';
      const before = args.before ? String(args.before).trim() : '';

      const params = new URLSearchParams({ subreddit, limit: String(limit), sort });
      if (query) params.set('query', query);
      if (after) params.set('after', after);
      if (before) params.set('before', before);

      const json = await arcGet<RawPost>('/posts/search', params, 'posts search');
      const rows = json.data ?? [];

      if (rows.length === 0) {
        await politeDelay();
        const info = await lookupSubreddit(subreddit);
        if (!info) {
          throw new Error(
            `r/${subreddit} was not found in the Arctic Shift subreddit index (checked via /api/subreddits/search) — ` +
              'it may not exist, be banned, be private, or be misspelled. This is a lookup failure, not an empty result.',
          );
        }
        return {
          subreddit,
          query: query || null,
          after: after || null,
          before: before || null,
          count: 0,
          posts: [],
          verified_empty: true,
          note: `r/${subreddit} exists in the Arctic Shift index (verified) but no posts matched this filter/date window — a genuine empty result, not a lookup failure.`,
        };
      }

      return {
        subreddit,
        query: query || null,
        after: after || null,
        before: before || null,
        count: rows.length,
        posts: rows.map(normalizePost),
      };
    }

    case 'reddit_history_comments': {
      const subreddit = args.subreddit ? normalizeSubreddit(args.subreddit) : '';
      const linkId = args.link_id ? normalizePostId(args.link_id) : '';
      if (!subreddit && !linkId) {
        throw new Error('Provide subreddit and/or link_id — reddit_history_comments needs at least one scope to search within.');
      }
      const limit = clampLimit(args.limit);
      const sort = args.sort === 'asc' ? 'asc' : 'desc';
      const query = args.query ? String(args.query).trim() : '';
      const after = args.after ? String(args.after).trim() : '';
      const before = args.before ? String(args.before).trim() : '';

      const params = new URLSearchParams({ limit: String(limit), sort });
      if (subreddit) params.set('subreddit', subreddit);
      if (linkId) params.set('link_id', linkId);
      if (query) params.set('body', query);
      if (after) params.set('after', after);
      if (before) params.set('before', before);

      const json = await arcGet<RawComment>('/comments/search', params, 'comments search');
      const rows = json.data ?? [];

      if (rows.length === 0) {
        await politeDelay();
        if (subreddit) {
          const info = await lookupSubreddit(subreddit);
          if (!info) {
            throw new Error(
              `r/${subreddit} was not found in the Arctic Shift subreddit index (checked via /api/subreddits/search) — ` +
                'it may not exist, be banned, be private, or be misspelled. This is a lookup failure, not an empty result.',
            );
          }
        } else if (linkId) {
          const exists = await postExists(linkId);
          if (!exists) {
            throw new Error(
              `Post ${linkId} was not found in the Arctic Shift archive (checked via /api/posts/ids) — ` +
                'check the id (no "t3_" prefix needed). This is a lookup failure, not an empty result.',
            );
          }
        }
        return {
          subreddit: subreddit || null,
          link_id: linkId || null,
          query: query || null,
          after: after || null,
          before: before || null,
          count: 0,
          comments: [],
          verified_empty: true,
          note: 'The scope (subreddit and/or post) was verified to exist, but no comments matched this filter/date window — a genuine empty result, not a lookup failure.',
        };
      }

      return {
        subreddit: subreddit || null,
        link_id: linkId || null,
        query: query || null,
        after: after || null,
        before: before || null,
        count: rows.length,
        comments: rows.map(normalizeComment),
      };
    }

    case 'subreddit_activity': {
      const subreddit = normalizeSubreddit(args.subreddit);
      if (!subreddit) throw new Error('subreddit is required (e.g. "datasets", without the r/ prefix).');
      const after = args.after ? String(args.after).trim() : monthsAgoIso(12);
      const before = args.before ? String(args.before).trim() : new Date().toISOString().slice(0, 10);

      const info = await lookupSubreddit(subreddit);
      if (!info) {
        throw new Error(
          `r/${subreddit} was not found in the Arctic Shift subreddit index (checked via /api/subreddits/search) — ` +
            'it may not exist, be banned, be private, or be misspelled.',
        );
      }

      await politeDelay();
      const aggParams = new URLSearchParams({
        aggregate: 'created_utc',
        frequency: 'month',
        subreddit,
        sort: 'asc',
        after,
        before,
      });
      const postsAgg = await arcGet<{ created_utc: string; count: string }>(
        '/posts/search/aggregate',
        aggParams,
        'posts aggregate',
      );

      await politeDelay();
      const commentsAgg = await arcGet<{ created_utc: string; count: string }>(
        '/comments/search/aggregate',
        aggParams,
        'comments aggregate',
      );

      const monthly = (rows: { created_utc: string; count: string }[] | null) =>
        (rows ?? []).map((r) => ({ month: aggregateBucketMonth(r.created_utc), count: Number(r.count) }));

      return {
        subreddit: info.display_name ?? subreddit,
        subscribers: info.subscribers ?? null,
        subreddit_created_utc: iso(info.created_utc),
        subreddit_type: info.subreddit_type ?? null,
        all_time_posts: info._meta?.num_posts ?? null,
        all_time_comments: info._meta?.num_comments ?? null,
        earliest_post_at: iso(info._meta?.earliest_post),
        earliest_comment_at: iso(info._meta?.earliest_comment),
        window: { after, before },
        monthly_posts: monthly(postsAgg.data),
        monthly_comments: monthly(commentsAgg.data),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
