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
- **Training workspace:** `#/practice` helps authenticated members choose one focus, follow manual workout
  instructions inside League, and log sessions and baseline/practice experiments. Optionally track completed cached
  matches against a frozen baseline and find reflection prompts for your own games. Review timestamped notes and
  annotations with an optional on-device video and local match-clock alignment; turn takeaways into spaced lessons
  and authored decision puzzles. Schematic strategy boards and simple calculators explain your own assumptions.
  Records are private to your membership; private teams require invitation acceptance and explicit sharing, never
  automatic access to personal notes. This replaces the browser League simulator, not League's Practice Tool.
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
Draft, and practice targets inside Coaching & habits. The training workspace is reached from the top bar and
Coaching focus cards; linked-player match fold-outs offer a private review link. It adds no player-profile tabs.
Charts always have numeric table views; background refreshes retain input, focus and disclosure state.

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

### Training workspace

Training works with an authenticated member login even without a linked Riot account. Start at `#/practice`:

- Save a one-focus weekly plan. Only one plan can be active; activating another archives the previous plan
  without deleting its history. Six authored workouts cover last hits, recall preparation, jungle clears, vision
  setup, rotation review and trading windows. Open League's Practice Tool or replay yourself and follow the
  instructions there; the site neither runs a simulated League game nor controls the client.
- Log sessions and reflections manually, including setup adherence and role/champion/patch context. A blank
  session result is missing, not zero. The **Recent progress** section covers loaded manual sessions only;
  optional cached-match observations are separate. Experiments compare manually recorded baseline and practice
  means with sample counts and context; empty groups stay unavailable. These are descriptive comparisons,
  not causal evidence or promises of rank gains.
- In **Connect practice to match results and choose a review moment**, explicitly load cached match progress,
  then choose **Start match tracking** for your saved plan. Tracking is opt-in, uses your currently linked account,
  and captures a role, optional champion (any champion is allowed), queue, patch and the saved plan's game count
  (1–20). It freezes the IDs of up to that many latest comparable games completed strictly before the start,
  then observes the **first N** comparable games started strictly afterward once they are completed—not the newest N.
  The start time retains fractional seconds, so a game already underway in the same second cannot slip in.
  Only verified completed, non-remake Summoner's Rift games in supported queues qualify. Both baseline and practice
  candidate searches inspect at most 200 cached matches each; this is not an all-history comparison. Missing baseline
  games keep their place rather than being replaced. Each metric has its own sample count; missing measurements,
  empty means and unavailable differences stay missing, not zero. Lane/jungle CS, lane gold and death measures are
  shown only where applicable. Partial timelines cannot establish a complete early-death count; lane-gold samples
  use a complete frame within 15 seconds of the target. Ordinary plan edits do not change the captured filters or window: explicitly restart
  to replace them. Start/restart and stop advance the saved plan revision without saving or replacing editor drafts;
  loading or refreshing cached progress never autosaves the plan or filter edits.
- Choose **Find cached review prompts** for either this plan's captured subsequent-game window or the latest ten
  completed cached Ranked Solo games across all roles, champions and patches. Only your currently linked account's
  own games are eligible. The queue offers at most six prompts, at most three per game, with timeline-availability
  counts and cached evidence. These are questions to investigate, not mistake verdicts, causal claims or recommended
  plays; no prompts does not mean no mistakes, and a missing timeline is not a game without events. Queue links only
  prefill the match and requested focus: they do not fetch context, create notes or save anything automatically.
- Use `#/practice/review` for timestamped decisions: what was known, plausible options, your decision, outcome
  and lesson, with arrows, circles or text annotations. A video is optional and must be playable by your browser.
  Selecting a file creates a temporary on-device Blob URL: footage, filename, device path and Blob URL are never
  saved or uploaded. Re-select the file on a later visit; detaching it or leaving the review revokes the URL.
  Only explicitly saved notes, manual labels, timestamps, clock basis and annotation coordinates go to the member
  database. Existing reviews default to **Video clock**; **Match clock** timestamps can be aligned by pausing at a known
  game time and entering that time (video time = match time + local offset). The offset is strictly local, never
  persisted or shared, and resets when the video, review or match changes. Changing a populated review's clock basis
  requires alignment and confirmation, converts every numeric moment timestamp atomically, and fails without partial
  changes if any conversion is invalid; it never merely relabels timestamps. Out-of-recording event/moment jumps report
  unavailable rather than silently seeking to zero. Team copies retain clock labels; already-derived lessons/puzzles
  keep their original clock labels. **Load cached match events** is a separate explicit action for your currently
  linked account's completed game; loading context does not add notes. Choose **Create review moment** to add an
  unsaved draft moment, then save explicitly. Cached retrospective evidence goes into Outcome, not what you knew
  at the time. Neither action downloads a missing match or timeline.
- Create personal question/answer lessons, including from saved review moments, and rate recall with Again,
  Good or Easy; the server schedules the next review. Due lists cover loaded lessons, so load older records to
  include older due dates. Decision puzzles are authored text scenarios, not footage analysis or an answer-key
  score: explain a choice before revealing tradeoffs and discussion, then save your reasoning and reflection.
- Use `#/practice/lab` for original schematic boards and physical-damage/armor/ability-haste calculations from
  numbers you enter. Boards are not exact map geometry or live positions. Calculators omit item passives,
  penetration, shields, critical strikes and ability/patch-specific interactions; they are not a combat simulator
  or a build recommendation. Numeric fields and tables provide keyboard alternatives to drawing and overlays.
- Invite existing members to private teams at `#/practice/team`. An invitation alone exposes neither documents
  nor the roster: acceptance is required. Only reviews, puzzles and boards can be created in a team or explicitly
  copied there; a copy is independent and never updates the personal original. Review/puzzle creators edit their
  documents, accepted members can edit shared boards, and the team owner can moderate/delete. Plans, sessions,
  lessons, attempts and experiments stay personal. No footage is shared; check notes for private information
  before copying. Removing membership revokes future team reads, not copies someone has already made.

Training makes **no new Riot calls** and has no AI analysis, live advice, client automation, recorder, video upload
or footage scraping. It claims no Riot approval. Existing analytics and linked-account goals remain separate;
unlinking or switching Riot accounts preserves training records and tracking links, but hides tracked cache progress
until you relink the captured account or explicitly restart for the new one. Deleting a plan removes its tracking
link, not independent notes. Removing a member with `auth.py remove <name>` erases their authored training data,
tracking links and memberships and deletes their owned teams, including those teams' shared documents. Other members'
independent copies are not recalled. Personal JSON export includes all personal records and a `tracking` field only
when tracking links exist (captured account, filters, fractional start, game count and frozen baseline IDs), not team
documents, cached match/timeline data, local calibration or video; it is not a video backup or workspace import feature.

Storage is lazily added to `users.db` with additive tables. The ordinary workspace, CRUD and export remain independent
of `cache.db`; only explicit match endpoints in `training_matches.py` open it read-only, without creating or migrating
it, fetching Riot data or training models. Missing/old caches stay honestly unavailable. Cache-derived progress and
review context are member-private, never part of player/cohort responses or team copies unless you explicitly author
and share notes. Back up `users.db` using SQLite's backup API before deployment. The enforced limits in `training.py`
are 200 authored records per member (personal records plus their authored documents in teams where membership is active),
100 documents per team, 10 active/pending team memberships per member and 20 active/pending members per team
(including the owner), with 32 KiB per record. Requests are capped
at 40 KiB in `training_api.py`. Initial lists contain at most 50 newest records per kind, with explicit truncation
flags and older-record pagination; export includes personal records beyond those initial pages. Leaving or losing
team access frees the author’s member quota without deleting shared documents; those remain under the team cap.
Pending re-invitations do not reclaim quota. Accepting re-invitation counts accessible authored documents again;
if that exceeds the member cap, editing/deletion still works, but new records require freeing space first.

Saves and deletes use revisions. A stale revision returns **409** and keeps your draft rather than overwriting
newer data; compare/copy your draft before explicitly reloading. Unsaved drafts are page-local, not autosaved or
stored in localStorage, and navigation warns before discarding them. Logout/session expiry clears private route
state and local media; warnings are not durable draft recovery. See [`TRAINING_CONTRACT.md`](TRAINING_CONTRACT.md)
for API, validation and ownership details.

Deploy `training.py`, `training_api.py`, `training_matches.py`, their auth/app integration and all four
`static/training*.js` modules plus `static/training.css` together; the app content-hashes these assets.
The old simulator is no longer loaded. Keep
its preserved code, artwork and tests in the ignored `legacy-practice/` archive, outside deployed `static/` and
active `tests/`; do not deploy that archive. Old `#/practice/lasthit` and `#/practice/dodge` links now open the
training hub with the last-hit or trading-window workout selected, not the old games. No new dependencies are needed.

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
for f in static/*.js tests/*.cjs; do node --check "$f"; done
node tests/training-core.cjs
node tests/training-review.cjs
node tests/training-lab.cjs
node tests/training-sync.cjs
```

The four training Node suites above need no browser. Browser checks use fully mocked responses at phone,
tablet and desktop widths (installing the existing optional Playwright/Chromium tooling requires network access):

```sh
npm install --prefix .browser-tools --no-save --package-lock=false playwright@1.64.0
node .browser-tools/node_modules/playwright/cli.js install chromium
NODE_PATH=.browser-tools/node_modules node tests/mobile.cjs
NODE_PATH=.browser-tools/node_modules node tests/insights.cjs
NODE_PATH=.browser-tools/node_modules node tests/training-core.cjs --browser
NODE_PATH=.browser-tools/node_modules node tests/training-review.cjs --browser
NODE_PATH=.browser-tools/node_modules node tests/training-lab.cjs --browser
NODE_PATH=.browser-tools/node_modules node tests/training-sync.cjs --browser
NODE_PATH=.browser-tools/node_modules node tests/training-matches.cjs
NODE_PATH=.browser-tools/node_modules node tests/training-team.cjs
NODE_PATH=.browser-tools/node_modules node tests/training.cjs
```

For an optional Safari-engine check, install WebKit with the same Playwright CLI (`install webkit`) and run
`BROWSER=webkit NODE_PATH=.browser-tools/node_modules node tests/training.cjs`. CI uses Chromium.

These checks use fixture cache/member databases and mocked API responses only, never real databases or Riot
calls. Python discovery includes `test_training.py`, `test_training_api.py`, `test_training_integration.py` and
`test_training_matches.py` for lazy/additive schema, strict validation and quotas, revision races, reference cleanup,
member/team privacy, unlink/account-switch retention, tracking export/deletion, read-only cache boundaries, bounded
candidate/digest work, frozen baseline/first-N windows and fractional-second opt-in boundaries. Training Node/browser
suites cover manual plans/sessions, zero versus missing data, experiments, explicit tracking/refresh and review-queue
scopes, local-video metadata boundaries and Blob URL cleanup, local clock calibration and atomic basis conversion,
explicit cached-context loading and focus-only links, annotations, lesson scheduling, puzzle reasoning,
boards/calculators, team acceptance/revocation, clock-label retention, 409 draft retention and stale route/member/plan
responses. `training-sync.cjs` runs pure checks by default and adds mocked browser checks with `--browser`;
`training-matches.cjs` runs both its frozen-fixture pure checks and mocked browser checks by default.
Existing analytics suites still cover timeline/build handling, bounded aggregation, temporal leakage, calibration,
goal privacy, explicit network actions and mobile/keyboard behavior.
The retired simulator suite is excluded from CI; its `legacy-practice/` archive is not part of active validation.

[CI](.github/workflows/ci.yml) runs all of the above, browser checks included, on every push to `main` and
every pull request. It needs no secrets or Riot key. When bumping Playwright, change it here and in the workflow.
