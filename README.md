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

- **Landing**: current patch stats (objectives, side win rate, champion win/pick/ban rates).
  Filled by a background sampler; set `SAMPLER=0` in `.env` to turn it off.
- **Player**: summary, then tabs for Champions (vs your rank), Draft (pick predictor),
  Habits and Win conditions.
