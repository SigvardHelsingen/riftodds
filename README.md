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
- **Match history:** every game type (ranked, normals, ARAM, ARAM: Mayhem, Arena) with expandable scoreboards.
- **Live game:** rank, mastery and recent form for all ten players in a player's current game.
- **Form over time:** rank history is the default graph for ranked players; switch to win rate, KDA, CS,
  gold, damage, vision or lane gold with a 10-game average. Rank history starts when tracking begins—Riot
  doesn't provide past LP. Linked and recently viewed accounts are checked every 20 minutes.
- **Builds and suggested picks:** the most successful core items, boots, runes and spells per champion and role
  on the current patch (open one from the patch board's champion table), and a Suggested picks tab with the
  highest win-rate champions in a player's main roles, each with its build.
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
| `TIMELINE_LIMIT` | `100` | newest games per player that get a timeline (gold-lead stats) |
| `SESSION_COOKIE_SECURE` | `auto` | set `1` in production behind HTTPS |

In production, run a **single worker** behind an HTTPS reverse proxy. The sampler, rate limiter,
login throttle and sync jobs live in process memory. When the API key changes, the old `cache.db`
is set aside as `cache.db.<date>.old` and a fresh cache is built.

Match history, builds and rank observations stay in SQLite on disk. For small-memory servers, downloads
use four-game batches (two active batches maximum), live entries are capped at 64 and finished sync
records at 128. Statistics stream database rows rather than keeping population-wide results in RAM;
SQLite targets 2 MiB of page cache per connection and uses disk for temporary query work.

## Tests

```sh
uv run python -m unittest discover -s tests
node --check static/app.js
```

Optional browser checks run against fully mocked responses at phone, tablet and desktop widths:

```sh
npm install --prefix .browser-tools --no-save --package-lock=false playwright@1.64.0
node .browser-tools/node_modules/playwright/cli.js install chromium
NODE_PATH=.browser-tools/node_modules node tests/mobile.cjs
```
