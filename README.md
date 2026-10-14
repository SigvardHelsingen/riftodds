# Rift Odds

**🔗 [riftodds.helsingen.no](https://riftodds.helsingen.no)** (invite-only, so ask for a login)

Rift Odds is a League of Legends stats site built around probabilities, not tier lists. Look up a
player by Riot ID to see how they pick, tilt and win. Every win rate comes with a 90% credible
interval, so "60% over 10 games" is shown with how sure it really is.

- **Patch board:** what decides ranked solo games on the current patch. It covers objective and side
  win rates, champion win/pick/ban rates, and how safe a gold lead at 15 minutes is. A background
  sampler keeps it filled with games from every tier.
- **Player profiles:** champion win rates compared with players of the same rank, a draft pick
  predictor (optionally by lane opponent), session and tilt habits, win conditions, and
  comeback and close-out rates.
- **Match history:** Ranked Solo, Ranked Flex, Normal Draft and Swiftplay, with expandable scoreboards.
  Standard Rift match fold-outs add a game story, actual purchase/skill order, and personal death/kill maps.
- **Roll the dice:** a random champion, lane and six-item challenge build on the landing page. Just for fun,
  not a meta recommendation.
- **Live game:** rank, mastery and recent form for visible players, plus clearly labeled historical jungle
  tendencies. An optional, policy-gated pregame estimate requires all ten roles to be assigned explicitly.
- **Form over time:** rank history is the default graph for ranked players; switch to win rate, KDA, CS,
  gold, damage, vision or lane gold with a 10-game average. Rank history starts when tracking begins—Riot
  doesn't provide past LP. Linked and recently viewed accounts are checked every 20 minutes.
- **Builds and suggested picks:** the most successful core items, boots, runes and spells per champion and role
  on the current patch (open one from the patch board's champion table), and a Suggested picks tab with the
  highest win-rate champions in a player's main roles, each with its build.
- **Draft matchups and Clash:** opponent-conditioned WR and paired gold at 10/15, with uncertain samples
  visible. Counter-pick options come from the selected player's own same-patch role pool. Clash scouting
  resolves a team ID and shows cached assigned-role pools, mastery pockets, and ban-coverage candidates.
- **Coaching & habits:** role-specific comparisons against current/next-tier game cohorts, percentile
  fingerprints, actionable practice targets, and private goals for your linked account. Progress uses
  the newest ten role-games started after the goal; LP pace is conditional on observed Riot rank snapshots.
- **Model evidence:** `#/odds` shows chronological holdout Brier/log-loss scores and reliability tables.
  Replay win-chance estimates appear only when an eligible model beats the frozen training-prior and
  50/50 baselines; other match types retain gold/event stories without solo-queue odds.
- **Admin page:** admins see each member's last visit, logins and player lookups.

## Running it yourself

Needs Python 3.12+, [uv](https://docs.astral.sh/uv/) and a [Riot API key](https://developer.riotgames.com).

```sh
echo "RIOT_API_KEY=RGAPI-..." > .env
uv sync
uv run fastapi dev main.py         # http://localhost:8000
uv run python auth.py add <name>   # create a login (also: passwd, remove, list)
uv run python auth.py role <name> admin   # or member; admins get the Admin page
```

Optional settings in `.env`:

| Variable | Default | |
|---|---|---|
| `SEASON_START` | `2026-01-08` | first day of the ranked season |
| `SAMPLER` | `1` | `0` turns the patch sampler off |
| `SAMPLER_TARGET` | `10000` | games per patch before the sampler idles |
| `SAMPLER_PLAYERS` | `8` | players sampled in parallel per tier |
| `TIMELINE_LIMIT` | `100` | newest games per player that get a timeline (gold, game story, build/skill order) |
| `LIVE_ODDS` | `0` | experimental live pregame estimates; enable only after Riot use-case review |
| `SESSION_COOKIE_SECURE` | `auto` | set `1` in production behind HTTPS |

In production, run a **single worker** behind an HTTPS reverse proxy. The sampler, rate limiter,
login throttle and sync jobs live in process memory. When the API key changes, the old `cache.db`
is set aside as `cache.db.<date>.old` and a fresh cache is built.

Match history, builds and rank observations stay in SQLite on disk. For small-memory servers, downloads
use four-game batches (two active batches maximum), live entries are capped at 64 and finished sync
records at 128. Statistics stream database rows rather than keeping population-wide results in RAM;
SQLite targets 2 MiB of page cache per connection and uses disk for temporary query work.

## Insights, sampling and migrations

The standing UI/data-safety rules are in [`AGENTS.md`](AGENTS.md). New features belong in existing
views: game stories inside match fold-outs, purchase order inside builds, matchup/Clash tools inside
Draft, and practice targets inside Coaching & habits. Charts always have numeric table views;
background refreshes retain input, focus and disclosure state.

### Data readiness

- Schema upgrades are additive. Cached raw matches are flattened into coaching metrics in background
  batches; no additional Riot requests are needed for those metrics. Back up both `cache.db` and
  `users.db` before deploying schema changes using SQLite's backup API, not a copy of an active WAL file.
- New timelines retain compressed, versioned digests: actual frame times and player/team mapping,
  gold/XP/CS/positions, kills/executions, objectives, buildings, plates and ward events. Purchase undo
  handling and normal skill points are stored separately. Raw ~1 MB timelines are not retained.
- Existing fetched timeline markers and gold10/15 rows remain intact. Previously discarded events
  cannot be recovered without a request: **Load game story** explicitly refreshes that game only.
  Normal history/sampling still respects bounded shared download slots and `TIMELINE_LIMIT`; deployment
  does not trigger a mass historical re-download. Riot-unavailable timelines remain honestly missing.
- Ordered builds use distinct finished purchases and typical completion times from timeline samples.
  Final-inventory combinations remain the fallback. First later shop-purchase timing is an observed
  proxy; it cannot distinguish a recall from a death or other shop access. Partial/nonstandard skill priorities are labeled
  estimates, not fully observed max orders. Item WR is descriptive; survival and game length affect it.
- A match's tier tag is a sampled **match-level proxy**, not each participant's historical rank. Tier
  cohorts can overlap. The softened sampling bell curve is a coverage choice, not the global ladder
  distribution. Coaching excludes every match containing the selected player from peer cohorts, scopes
  comparisons to the shown patch and role, and preserves per-metric missingness/sample counts.
- Coaching requires five valid player observations and 20 peer observations for percentile/goal
  suggestions. Counter options require three own-pool games and 15 peer matchup games. Small-sample
  observed WR still has a 90% credible interval; the separately shrunk ranking score is not observed WR.
- Jungle locations at 2:00 are nearest-camp proximity proxies, not proof of the starting buff. Early
  lane takedowns are kills/assists before ten minutes, **not all ganks**. Nothing tracks a live enemy path.
- Clash reads no more than 50 cached solo games per player before assigned-role filtering. Fetching
  missing histories/mastery requires an explicit action; up to five short match-only syncs use the
  existing background limiter. Unresolved/legacy IDs and unknown roles are not fabricated.
- Goals are stored separately per member, current linked account, role and metric; unlinking/changing
  accounts removes them. Public/cohort responses do not contain another member's private goals. The
  existing self-link action is not Riot Sign On or proof of Riot account ownership.

### Odds and observed LP pace

Both models use bounded pure-Python logistic regression without additional dependencies. Fitting runs
in a separate low-priority process, first considered two minutes after startup and then checked every
10 minutes; models are retrained at most every six hours. Each process has a five-minute timeout and
is killed/reaped on cancellation. Reads/inference never trigger training.

Training is capped at 6,000 eligible solo games from 120 days and 20,000 in-game minute samples. At
least 200 eligible games are required. The newest fifth of games is held out chronologically; equal
start groups stay together and unresolved overlapping games are excluded. Pregame features use only
already completed TRAIN games, with frozen TRAIN counts/history on the holdout. Weights are never
refitted on holdout labels. GAME_END/nexus/terminal states are excluded from in-game evaluation.

`#/odds` exposes sample counts versus distinct games, probability quality and reliability—not a
promised accuracy. Its bins are diagnostic, not holdout-fitted recalibration. Retrospective replay
estimates do not assert that a particular replay was held out or predicted at that historical time.
Pregame inference uses draft, role matchups and eligible earlier cached champion history/form, **not
current mastery or rank substituted for missing historical features**. Lack of validated evidence
means unavailable odds, not a confident 50/50 prediction.

For an explicit operator-run fit (no Riot calls), after enough eligible data is available:

```sh
.venv/bin/python model.py train
# Or a fixture/scratch database, never member data:
.venv/bin/python model.py train --db path/to/fixture.sqlite
```

Displayed LP pace uses Riot rank and season win/loss observations only. Resets, corrections, missing
or negative pace, and dynamic apex thresholds suppress a games-to-next-tier estimate. The displayed
range describes observed interval variation, not calibrated confidence or a promotion guarantee.
There is no MMR/Elo replacement or betting functionality.

Review/update the product registration against [Riot's current policies](https://developer.riotgames.com/docs/lol#game-policy)
before public enablement: game-session-specific previously unknown information and hidden-player
analysis are restricted. **Live odds default off**; `LIVE_ODDS=1` is an operator flag for a reviewed
use case, not evidence of Riot approval. Historical analysis uses no inferred hidden identities.
Custom match histories are not exposed by these new features.

No new package dependencies are required. Restart the service after deploying all Python modules,
JavaScript and CSS assets together; content-hashed URLs cover both new insight assets too.

## Tests

```sh
uv run python -m unittest discover -s tests
uvx ruff@0.17.0 check .   # bug-finding rules only; see [tool.ruff] in pyproject.toml
node --check static/app.js
node --check static/insights.js
```

Browser checks run against fully mocked responses at phone, tablet and desktop widths:

```sh
npm install --prefix .browser-tools --no-save --package-lock=false playwright@1.64.0
node .browser-tools/node_modules/playwright/cli.js install chromium
NODE_PATH=.browser-tools/node_modules node tests/mobile.cjs
NODE_PATH=.browser-tools/node_modules node tests/insights.cjs
```

These checks use fixture cache/member databases and mocked API responses only. The suites cover
schema/legacy transitions, malformed/undo/timestamp handling, bounded aggregation, temporal leakage,
calibration, goal privacy, stale requests, explicit network actions, and mobile/keyboard interaction.

[CI](.github/workflows/ci.yml) runs all of the above, browser checks included, on every push to `main` and
every pull request. It needs no secrets or Riot key. When bumping Playwright, change it here and in the workflow.
