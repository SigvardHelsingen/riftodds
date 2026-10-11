# League player probabilities

A minimal League of Legends stats page focused on a single player.

## Setup

Put your Riot API key in `.env`:

```
RIOT_API_KEY=RGAPI-...
```

Then:

```
uv sync
uv run fastapi dev main.py
```

Open http://localhost:8000.

## Views

- **Landing**: current patch stats: objectives, side win rate, champion win/pick/ban rates and
  how safe a gold lead at 15 is. Filled by a background sampler.
- **Player**: profile, then tabs for Live game (when in one), Champions (vs your rank, with mastery),
  Draft (pick predictor, pocket picks), Habits and Win conditions (incl. comeback and close-out rates).
  Pick a range from the last 20 games up to the whole season; long ranges sync in the background.

On phones, the header search sits below the account controls, profile controls and cards
resize to the available space, and wide stats/scoreboard tables scroll inside their cards.
Swipe a table horizontally to see the remaining columns; keyboard users can focus the
scroll region. Inputs use mobile-friendly sizes, and reduced-motion preferences are respected.

## Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `RIOT_API_KEY` | – | required |
| `SEASON_START` | `2026-01-08` | first day of the ranked season |
| `SAMPLER` | `1` | `0` turns the patch sampler off |
| `SAMPLER_TARGET` | `10000` | games per patch before the sampler idles |
| `SAMPLER_PLAYERS` | `8` | players sampled in parallel per tier |
| `TIMELINE_LIMIT` | `100` | newest games per player that get a timeline (gold-lead stats) |
| `SESSION_COOKIE_SECURE` | `auto` | `1` always sets Secure cookies (HTTPS production); `0` is development-only; `auto` follows the request scheme |

Settings load before the history module reads them. Exported environment variables take
precedence over `.env`.

Rate limits are read from Riot's response headers, so any key works at its own limits.
PUUIDs are tied to the API key: when the key changes, the old `cache.db` is set aside
(`cache.db.<date>.old`, safe to delete) and a fresh cache is built.

## Users

The site is invite-only. Manage logins on the server:

```
uv run python auth.py add <username>      # prompts for a password
uv run python auth.py passwd <username>
uv run python auth.py remove <username>
uv run python auth.py list
```

Users and sessions are stored in `users.db` (not in git).

Usernames must be 1–64 characters and passwords 8–1024 characters. Existing credentials
outside those bounds must be updated. No database migration is required.

Login attempts are reserved atomically before password hashing: 10 per username per
15 minutes, 20 per client per minute, and 100 globally per rolling minute, with at most
4 concurrent login operations. Throttled attempts return the same generic response as
incorrect credentials. This throttle is bounded, expiring, and process-local.

## Deployment

Run **one worker**. The sampler, Riot rate limiter, login throttle, live cache, and
history-job coordination are process-local; multiple workers are not supported safely.

For production, terminate HTTPS at a trusted reverse proxy and set
`SESSION_COOKIE_SECURE=1`. Configure the ASGI server to trust forwarded scheme/client
headers **only from that proxy**, enforce HTTPS at the edge, and do not expose the backend
port publicly. The default `auto` setting is convenient locally but depends on correct
proxy configuration in production.

Failed history fetches retain successfully cached games and surface a retryable error
instead of claiming completion. Riot API-key failures return an upstream error, not a
user-session 401, so replacing an expired Riot key does not force users back to login.
If re-resolving a linked account fails temporarily during key rotation, its saved Riot ID
is retained; look the account up and re-link it if needed.

## Tests

The backend regression suite uses standard-library `unittest`, mock API clients, and
isolated SQLite fixtures. It does not need a Riot key or a running application:

```sh
uv run python -m unittest discover -s tests
node --check static/app.js
```

Optional browser checks use Playwright with fully mocked requests (including images/fonts),
without starting the backend. They cover 320, 375, 390, 768, and 1280px layouts, every
player tab, horizontally scrollable tables, phone tap targets, login/logout, sync states,
and stale responses during navigation:

```sh
npm install --prefix .browser-tools --no-save --package-lock=false playwright@1.64.0
node .browser-tools/node_modules/playwright/cli.js install chromium
NODE_PATH=.browser-tools/node_modules node tests/mobile.cjs
```

`.browser-tools/` is ignored and is not an application dependency. Set `BROWSER=webkit`
or `BROWSER=firefox` after installing that Playwright browser to run another engine.
`PLAYWRIGHT_EXECUTABLE_PATH` can select an existing compatible browser executable.
Chromium has been checked; the attempted WebKit run timed out, so Safari and physical-device
behavior still need checking.

## Remaining review findings

These are known limitations, not claims of full production readiness:

- **Concurrent viewers:** history jobs are keyed by player, so two viewers selecting
  different ranges for the same player can cancel each other's sync. Stored results are
  retained, but range-specific job/status coordination still needs work.
- **Live lookup failures:** failed rank/mastery requests can be cached as empty data for
  the rest of a live game, presenting unavailable rank data as Unranked. Failed fields
  should be distinguished from empty results and retried separately.
- **Probability accuracy:** the Beta normal approximation and fixed integration grid are
  unreliable for very skewed or concentrated distributions. Rank comparisons also use
  sampled match cohorts, not verified historical ranks for every participant; P(better)
  is a model estimate, not proof of superior skill.
- **Startup availability:** Data Dragon failures are checked and retried, but an extended
  outage can still prevent startup. A last-known-good disk snapshot would improve this.
- **Cache lifecycle/performance:** unavailable timelines are permanently marked fetched;
  rank-lead memoization is not keyed by database generation; small player ranges still
  read the full match history before filtering. Some remaining database connections and
  synchronous writes in async endpoints also deserve a lifecycle/load-testing pass.
