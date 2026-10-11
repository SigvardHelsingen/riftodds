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
- **Form over time:** a chart on every profile of win rate, KDA, CS, gold, damage, vision or lane gold per game,
  with a 10-game average.
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
