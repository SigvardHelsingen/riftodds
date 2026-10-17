"""Private, member-owned practice notes. No Riot, cache, network or import-time DB work.

All normal operations use a short transaction on an auth connection with foreign keys
explicitly enabled. erase_member instead participates in its caller's transaction,
including auth's deliberately FK-off CLI connection.
"""
import copy
import json
import re
import sqlite3
import time
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import date
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError, model_validator

import auth

KINDS = ("plans", "sessions", "reviews", "lessons", "puzzles", "attempts", "experiments", "boards")
TEAM_KINDS = ("reviews", "puzzles", "boards")
MAX_MEMBER_ENTRIES = 200
MAX_TEAM_ENTRIES = 100
MAX_MEMBER_TEAMS = 10  # active and invited combined; also bounds bootstrap/rosters
MAX_TEAM_MEMBERS = 20  # includes the owner and pending invitations
MAX_ENTRY_BYTES = 32 * 1024
PAGE_SIZE = 50
MAX_TIMESTAMP = 253402300799
MAX_REVISION = 2 ** 31 - 1


class Error(Exception):
    def __init__(self, status, detail):
        self.status = status
        self.detail = detail
        super().__init__(detail)


def _text(value, prose=False):
    if any(unicodedata.category(c).startswith("C") and not (prose and c in "\n\r\t") for c in value):
        raise ValueError("Control characters are not allowed")
    return value


def _label(value):
    return _text(value)


def _prose(value):
    return _text(value, prose=True)


def _nonblank(value):
    if not value.strip():
        raise ValueError("Must not be blank")
    return value


def _source_label(value):
    # A human label, never a local device path, remote URL, data URL or file upload.
    if re.search(r"[/\\]|^[a-zA-Z][a-zA-Z0-9+.-]*:|^~", value):
        raise ValueError("Use a descriptive source label, not a path or URL")
    return value


def _date(value):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Use YYYY-MM-DD")
    date.fromisoformat(value)
    return value


Label = Annotated[str, Field(strict=True, max_length=160), AfterValidator(_label)]
Title = Annotated[str, Field(strict=True, min_length=1, max_length=120), AfterValidator(_label), AfterValidator(_nonblank)]
Prose = Annotated[str, Field(strict=True, max_length=4000), AfterValidator(_prose)]
RequiredProse = Annotated[Prose, Field(min_length=1), AfterValidator(_nonblank)]
Identifier = Annotated[str, Field(strict=True, min_length=1, max_length=160), AfterValidator(_label), AfterValidator(_nonblank)]
Username = Annotated[str, Field(strict=True, min_length=1, max_length=auth.MAX_USERNAME_LENGTH), AfterValidator(_label)]
Revision = Annotated[int, Field(strict=True, ge=1, le=MAX_REVISION)]
Coordinate = Annotated[float, Field(strict=True, ge=0, le=1, allow_inf_nan=False)]
Seconds = Annotated[float, Field(strict=True, ge=0, le=28800, allow_inf_nan=False)]
Role = Literal["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY", ""]
WorkoutID = Literal["last-hit", "recall", "jungle-clear", "vision-setup", "review-rotation", "trading-window"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Plan(StrictModel):
    title: Title
    focus: Prose
    role: Role
    champion: Label
    workout_id: WorkoutID
    minutes: Annotated[int, Field(ge=1, le=120)]
    games: Annotated[int, Field(ge=1, le=20)]
    status: Literal["active", "archived"]


class Session(StrictModel):
    plan_id: Identifier | None
    workout_id: WorkoutID
    minutes: Annotated[int, Field(ge=0, le=240)]
    repetitions: Annotated[int, Field(ge=1, le=100)]
    result: Annotated[float, Field(ge=-1_000_000_000, le=1_000_000_000)] | None
    unit: Label
    focus: Prose
    reflection: Prose
    adhered: bool
    role: Label
    champion: Label
    patch: Label


class Annotation(StrictModel):
    kind: Literal["arrow", "circle", "text"]
    x: Coordinate
    y: Coordinate
    x2: Coordinate
    y2: Coordinate
    text: Label


class Moment(StrictModel):
    id: Identifier
    seconds: Seconds
    title: Title
    known: Prose
    options: Prose
    decision: Prose
    outcome: Prose
    lesson: Prose
    annotations: Annotated[list[Annotation], Field(max_length=30)]


class Review(StrictModel):
    title: Title
    match_id: Annotated[Label, AfterValidator(_source_label)]
    source_label: Annotated[Label, AfterValidator(_source_label)]
    time_basis: Literal["video", "match"] = "video"
    moments: Annotated[list[Moment], Field(max_length=50)]

    @model_validator(mode="after")
    def unique_moments(self):
        _unique_ids(self.moments)
        return self


class Lesson(StrictModel):
    question: RequiredProse
    answer: RequiredProse
    source_review_id: Identifier | None
    due: Annotated[int, Field(ge=0, le=MAX_TIMESTAMP)]
    interval_days: Annotated[int, Field(ge=1, le=365)]
    repetitions: Annotated[int, Field(ge=0, le=1000)]


class Choice(StrictModel):
    label: Annotated[Label, Field(min_length=1), AfterValidator(_nonblank)]
    tradeoff: Prose


class Puzzle(StrictModel):
    title: Title
    prompt: RequiredProse
    context: Prose
    choices: Annotated[list[Choice], Field(min_length=2, max_length=5)]
    discussion: Prose
    source_review_id: Identifier | None
    seconds: Seconds | None


class Attempt(StrictModel):
    puzzle_id: Identifier
    choice_index: Annotated[int, Field(ge=0, le=4)]
    reason: Prose
    reflection: Prose


class Observation(StrictModel):
    id: Identifier
    date: Annotated[str, Field(min_length=10, max_length=10), AfterValidator(_date)]
    phase: Literal["baseline", "practice"]
    value: Annotated[float, Field(ge=0, le=100000)]
    adhered: bool
    context: Prose


class Experiment(StrictModel):
    title: Title
    hypothesis: RequiredProse
    change: RequiredProse
    measure: Label
    unit: Label
    better: Literal["higher", "lower"]
    role: Label
    champion: Label
    patch: Label
    phase: Literal["baseline", "practice", "complete"]
    observations: Annotated[list[Observation], Field(max_length=100)]

    @model_validator(mode="after")
    def unique_observations(self):
        _unique_ids(self.observations)
        return self


class Mark(StrictModel):
    id: Identifier
    kind: Literal["arrow", "ward", "position", "text"]
    x: Coordinate
    y: Coordinate
    x2: Coordinate
    y2: Coordinate
    label: Label
    team: Literal["blue", "red", "neutral"]


class Board(StrictModel):
    title: Title
    notes: Prose
    marks: Annotated[list[Mark], Field(max_length=100)]

    @model_validator(mode="after")
    def unique_marks(self):
        _unique_ids(self.marks)
        return self


def _unique_ids(items):
    if len({item.id for item in items}) != len(items):
        raise ValueError("IDs within a document must be unique")


MODELS = dict(zip(KINDS, (Plan, Session, Review, Lesson, Puzzle, Attempt, Experiment, Board)))

WORKOUTS = [
    {"id": "last-hit", "title": "Consistent last hits", "roles": ["TOP", "MIDDLE", "BOTTOM"], "minutes": 10,
     "goal": "Compare your last hits using the same manual practice setup inside League.",
     "steps": ["Open League's Practice Tool with the same champion and items.",
               "Choose a fixed wave window and last-hit without opponents.",
               "Repeat the window; record last hits and what changed."],
     "measure": "Last hits in your chosen wave window", "unit": "last hits",
     "tip": "Keep setup and duration consistent; this is not a rank or pass/fail target."},
    {"id": "recall", "title": "Recall preparation", "roles": ["TOP", "MIDDLE", "BOTTOM", "UTILITY"], "minutes": 10,
     "goal": "Practice preparing a recall in League, then explain the tradeoff.",
     "steps": ["Use Practice Tool to inspect a wave before recalling.",
               "Name what you gain and what you may miss by leaving now.",
               "Repeat a different wave state and compare your reasoning."],
     "measure": "Recall situations explained", "unit": "situations",
     "tip": "Opponent pressure and resources can change which timing is reasonable."},
    {"id": "jungle-clear", "title": "Repeatable jungle clear", "roles": ["JUNGLE"], "minutes": 15,
     "goal": "Compare a manual clear route under consistent conditions inside League.",
     "steps": ["Choose one champion, route and starting setup in Practice Tool.",
               "Record route time and a note about health or execution.",
               "Repeat the same setup before testing one change."],
     "measure": "Time for the chosen route", "unit": "seconds",
     "tip": "Patch, leash, champion and route affect results; do not compare unlike setups."},
    {"id": "vision-setup", "title": "Vision before an objective", "roles": ["JUNGLE", "UTILITY"], "minutes": 10,
     "goal": "Rehearse a vision route manually in League and explain safe alternatives.",
     "steps": ["Choose an objective and a hypothetical lane-priority state.",
               "Walk a ward route in Practice Tool and name risky entrances.",
               "Change the available information and identify a safer fallback."],
     "measure": "Routes explained", "unit": "routes",
     "tip": "A ward location is not automatically safe when teammates cannot move."},
    {"id": "review-rotation", "title": "Review a rotation", "roles": ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"], "minutes": 15,
     "goal": "Review a completed game in League without using hindsight as a decision rule.",
     "steps": ["Pause a replay before a rotation.", "Write only information available at that moment.",
               "Compare two plausible options, then record the outcome separately."],
     "measure": "Decisions reviewed", "unit": "decisions",
     "tip": "A good outcome alone does not establish that the decision was good."},
    {"id": "trading-window", "title": "Trading windows", "roles": ["TOP", "MIDDLE", "BOTTOM", "UTILITY"], "minutes": 10,
     "goal": "Identify a trading window and practice the sequence manually inside League.",
     "steps": ["Choose a champion and one cooldown or wave condition.",
               "Rehearse a short sequence in Practice Tool.",
               "Write when you would avoid the trade despite the available cooldown."],
     "measure": "Sequences practiced", "unit": "repetitions",
     "tip": "These are manual exercises, not live decision assistance or guaranteed winning trades."},
]
STARTER_PUZZLES = [
    {"id": "recall-window", "title": "A possible recall window", "prompt": "Do you leave now or stay for another wave?",
     "context": "You have gold to spend and low resources. The next wave is approaching; enemy jungle position is unknown.",
     "choices": [{"label": "Recall now", "tradeoff": "Spend gold and recover, but possibly concede some wave control."},
                 {"label": "Prepare one more wave", "tradeoff": "May improve the return timing, but extends exposure while low."}],
     "discussion": "Wave position, travel time, opponent resources and cover matter. Neither option guarantees a better result.",
     "source_review_id": None, "seconds": None},
    {"id": "objective-trade", "title": "Trade or contest?", "prompt": "How might you respond to an objective setup?",
     "context": "Opponents arrived first at dragon. Your nearby lanes cannot immediately move; another lane has an available wave.",
     "choices": [{"label": "Concede and trade elsewhere", "tradeoff": "Avoids a late entry but gives up this objective."},
                 {"label": "Gather information before deciding", "tradeoff": "Keeps options open but costs time and may expose a teammate."},
                 {"label": "Wait for a coordinated contest", "tradeoff": "Could create an opening if resources and timing allow; arriving late is risky."}],
     "discussion": "Objective value, vision, cooldowns and numbers can change the choice. Discuss what information would justify each option.",
     "source_review_id": None, "seconds": None},
    {"id": "unsafe-wave", "title": "An exposed side wave", "prompt": "Who should collect the wave, if anyone?",
     "context": "A wave is beyond your safe vision line. Several opponents are missing and your team is resetting.",
     "choices": [{"label": "Wait for more information", "tradeoff": "May lose farm while reducing exposure."},
                 {"label": "Collect with a planned escape and cover", "tradeoff": "Keeps resources flowing only if cover and escape are genuinely available."}],
     "discussion": "Mobility, revealed opponents, team timing and wave direction matter. Missing information is not proof of safety.",
     "source_review_id": None, "seconds": None},
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS training_teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, created INTEGER NOT NULL,
    FOREIGN KEY(owner) REFERENCES users(username) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS training_memberships (
    team_id TEXT NOT NULL, username TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','invited')),
    created INTEGER NOT NULL, PRIMARY KEY(team_id,username),
    FOREIGN KEY(team_id) REFERENCES training_teams(id) ON DELETE CASCADE,
    FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_training_memberships_user ON training_memberships(username,status);
CREATE TABLE IF NOT EXISTS training_entries (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN
        ('plans','sessions','reviews','lessons','puzzles','attempts','experiments','boards')),
    owner TEXT NOT NULL, team_id TEXT, revision INTEGER NOT NULL CHECK(revision >= 1),
    created INTEGER NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 32768),
    CHECK(team_id IS NULL OR kind IN ('reviews','puzzles','boards')),
    FOREIGN KEY(owner) REFERENCES users(username) ON DELETE CASCADE,
    FOREIGN KEY(team_id) REFERENCES training_teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_training_entries_owner ON training_entries(owner,team_id,kind,created DESC,id DESC);
CREATE INDEX IF NOT EXISTS ix_training_entries_team ON training_entries(team_id,kind,created DESC,id DESC);
CREATE TABLE IF NOT EXISTS training_plan_links (
    plan_id TEXT PRIMARY KEY, owner TEXT NOT NULL, puuid TEXT NOT NULL,
    role TEXT NOT NULL, champion_id INTEGER, queue_id INTEGER NOT NULL, patch TEXT NOT NULL,
    started INTEGER NOT NULL, games INTEGER NOT NULL CHECK(games BETWEEN 1 AND 20),
    baseline_ids TEXT NOT NULL,
    FOREIGN KEY(plan_id) REFERENCES training_entries(id) ON DELETE CASCADE,
    FOREIGN KEY(owner) REFERENCES users(username) ON DELETE CASCADE
);
"""


def connect():
    """Lazily add only training tables; never change auth.connect's FK semantics."""
    db = auth.connect()
    try:
        db.execute("PRAGMA foreign_keys=ON")
        if db.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
            raise RuntimeError("Training requires foreign key enforcement")
        db.executescript(SCHEMA)
        db.row_factory = sqlite3.Row
        return db
    except BaseException:
        db.close()
        raise


@contextmanager
def _transaction(username, write=False):
    db = connect()
    try:
        # Membership, reference checks, quotas and writes share the same snapshot/lock.
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        if not db.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise Error(401, "Membership is no longer available")
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def _kind(kind):
    if kind not in MODELS:
        raise Error(404, "Unknown training kind")


def _model(model, value):
    try:
        return model.model_validate(value).model_dump()
    except ValidationError as error:
        # Never echo input (private prose, nonfinite values or untrusted object keys).
        messages = []
        for item in error.errors()[:8]:
            if item["type"] == "extra_forbidden":
                messages.append("Unknown fields are not allowed")
            else:
                location = ".".join(str(part) for part in item["loc"]) or "data"
                messages.append(f"{location}: {item['msg']}")
        raise Error(422, "Invalid training data: " + "; ".join(messages)) from error


def _encode(data):
    encoded = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_ENTRY_BYTES:
        raise Error(413, "Entry exceeds the 32 KiB storage limit")
    return encoded


def validate_data(kind, data):
    _kind(kind)
    result = _model(MODELS[kind], data)
    _encode(result)
    return result


def _entry(row):
    result = dict(row)
    result["data"] = json.loads(result["data"])
    if result["kind"] == "reviews":
        result["data"].setdefault("time_basis", "video")
    return result


def _team(db, username, team_id, invited=False):
    row = db.execute(
        """SELECT t.*, m.status FROM training_teams t JOIN training_memberships m ON m.team_id=t.id
           WHERE t.id=? AND m.username=?""", (team_id, username)).fetchone()
    if row is None or (row["status"] != "active" and not invited):
        raise Error(404, "Training team not found")
    return row


def _team_record(db, row):
    result = {key: row[key] for key in ("id", "name", "owner", "created")}
    result["members"] = [dict(member) for member in db.execute(
        "SELECT username,status FROM training_memberships WHERE team_id=? ORDER BY username", (row["id"],))]
    return result


def _find_entry(db, username, kind, entry_id):
    row = db.execute(
        """SELECT e.* FROM training_entries e WHERE e.id=? AND e.kind=? AND
           ((e.team_id IS NULL AND e.owner=?) OR
            EXISTS (SELECT 1 FROM training_memberships m WHERE m.team_id=e.team_id
                    AND m.username=? AND m.status='active'))""", (entry_id, kind, username, username)).fetchone()
    if row is None:
        # Identical status/detail for unknown, private and revoked shared IDs.
        raise Error(404, "Training entry not found")
    return row


def _references(db, username, kind, data, team_id):
    reference = None
    reference_kind = None
    if kind == "sessions":
        reference, reference_kind = data["plan_id"], "plans"
    elif kind in ("lessons", "puzzles"):
        reference, reference_kind = data["source_review_id"], "reviews"
    if reference is not None:
        row = _find_entry(db, username, reference_kind, reference)
        if row["team_id"] != team_id:
            raise Error(404, "Training entry not found")
    if kind == "attempts":
        puzzle = next((p for p in STARTER_PUZZLES if p["id"] == data["puzzle_id"]), None)
        if puzzle is None:
            # Personal attempts may practice an accessible shared puzzle, never a private third-party one.
            puzzle = _entry(_find_entry(db, username, "puzzles", data["puzzle_id"]))["data"]
        if data["choice_index"] >= len(puzzle["choices"]):
            raise Error(422, "Choice index is outside this puzzle's choices")


def _revision(row, revision, increment=True):
    _model(RevisionBody, {"revision": revision})
    if row["revision"] != revision:
        raise Error(409, "This entry changed. Reload it before saving or deleting.")
    if increment and revision == MAX_REVISION:
        raise Error(409, "This entry has reached its revision limit; export, copy or delete it.")


class RevisionBody(StrictModel):
    revision: Revision


def _can_edit(row, username):
    if row["owner"] != username and not (row["team_id"] is not None and row["kind"] == "boards"):
        raise Error(403, "Only the creator can edit this document")


def _archive_plans(db, username, data, now, exclude=None):
    if data["status"] != "active":
        return
    rows = db.execute("SELECT * FROM training_entries WHERE owner=? AND kind='plans' AND team_id IS NULL",
                      (username,)).fetchall()
    for row in rows:
        old = json.loads(row["data"])
        if row["id"] != exclude and old["status"] == "active":
            if row["revision"] == MAX_REVISION:
                raise Error(409, "The previous plan reached its revision limit; export and delete it before activating a new plan")
            old["status"] = "archived"
            db.execute("UPDATE training_entries SET data=?,revision=revision+1,updated=? WHERE id=?",
                       (_encode(old), now, row["id"]))


def _member_entry_count(db, username):
    """Exclude team contributions the author can no longer access or reclaim."""
    return db.execute(
        """SELECT COUNT(*) FROM training_entries e WHERE e.owner=? AND
           (e.team_id IS NULL OR EXISTS (
               SELECT 1 FROM training_memberships m WHERE m.team_id=e.team_id
               AND m.username=e.owner AND m.status='active'))""", (username,)).fetchone()[0]


def create_entry(username, kind, data, team_id=None):
    data = validate_data(kind, data)
    if team_id is not None and kind not in TEAM_KINDS:
        raise Error(422, "This kind is private and cannot be shared")
    if team_id is not None:
        _model(TeamScope, {"team_id": team_id})
    with _transaction(username, write=True) as db:
        if team_id is not None:
            _team(db, username, team_id)
            if db.execute("SELECT COUNT(*) FROM training_entries WHERE team_id=?", (team_id,)).fetchone()[0] >= MAX_TEAM_ENTRIES:
                raise Error(409, "Team storage limit reached; delete or export older documents")
        if _member_entry_count(db, username) >= MAX_MEMBER_ENTRIES:
            raise Error(409, "Member storage limit reached; delete or export older records")
        _references(db, username, kind, data, team_id)
        now = int(time.time())
        if kind == "plans":
            _archive_plans(db, username, data, now)
        if kind == "lessons":
            data.update(due=now, interval_days=1, repetitions=0)
        entry_id = uuid.uuid4().hex
        db.execute("INSERT INTO training_entries VALUES (?,?,?,?,?,?,?,?)",
                   (entry_id, kind, username, team_id, 1, now, now, _encode(data)))
        return _entry(_find_entry(db, username, kind, entry_id))


class TeamScope(StrictModel):
    team_id: Identifier | None


def update_entry(username, kind, entry_id, data, revision):
    _kind(kind)
    with _transaction(username, write=True) as db:
        row = _find_entry(db, username, kind, entry_id)
        _can_edit(row, username)
        _revision(row, revision)
        data = validate_data(kind, data)
        _references(db, username, kind, data, row["team_id"])
        now = int(time.time())
        if kind == "plans":
            _archive_plans(db, username, data, now, exclude=entry_id)
        if kind == "lessons":
            old = json.loads(row["data"])
            data.update({key: old[key] for key in ("due", "interval_days", "repetitions")})
        db.execute("UPDATE training_entries SET data=?,revision=revision+1,updated=? WHERE id=?",
                   (_encode(data), now, entry_id))
        return _entry(_find_entry(db, username, kind, entry_id))


def _clear_references(db, deleted_rows):
    """Detach nullable sources without deleting independently authored notes.

    Scope checks at creation bound each candidate list to one member or team.
    Attempts have required puzzle IDs: retain those historical links and reasoning,
    but never use them to bypass current access/choice checks on a later save.
    """
    deleted_ids = {row["id"] for row in deleted_rows}
    sources = {}
    for row in deleted_rows:
        if row["kind"] in ("plans", "reviews"):
            scope = (row["kind"], row["team_id"], row["owner"] if row["team_id"] is None else None)
            sources.setdefault(scope, set()).add(row["id"])
    now = int(time.time())
    for (kind, team_id, owner), source_ids in sources.items():
        field, kinds = ("plan_id", "'sessions'") if kind == "plans" else ("source_review_id", "'lessons','puzzles'")
        scope, value = ("team_id=?", team_id) if team_id is not None else ("team_id IS NULL AND owner=?", owner)
        candidates = db.execute(f"SELECT id,data FROM training_entries WHERE {scope} AND kind IN ({kinds})", (value,)).fetchall()
        for entry_id, encoded in candidates:
            if entry_id in deleted_ids:
                continue
            data = json.loads(encoded)
            if data[field] in source_ids:
                data[field] = None
                # Saturated documents are already write-locked; they remain deletable.
                db.execute("UPDATE training_entries SET data=?,revision=MIN(revision+1,?),updated=? WHERE id=?",
                           (_encode(data), MAX_REVISION, now, entry_id))


def delete_entry(username, kind, entry_id, revision):
    _kind(kind)
    with _transaction(username, write=True) as db:
        row = _find_entry(db, username, kind, entry_id)
        if row["owner"] != username:
            if row["team_id"] is None or _team(db, username, row["team_id"])["owner"] != username:
                raise Error(403, "Only the creator or team owner can delete this document")
        _revision(row, revision, increment=False)
        _clear_references(db, [row])
        db.execute("DELETE FROM training_entries WHERE id=?", (entry_id,))
    return {"ok": True}


class Grade(RevisionBody):
    rating: Literal["again", "good", "easy"]


def grade_lesson(username, entry_id, revision, rating):
    _model(Grade, {"revision": revision, "rating": rating})
    with _transaction(username, write=True) as db:
        row = _find_entry(db, username, "lessons", entry_id)
        _revision(row, revision)
        data = json.loads(row["data"])
        previous = data["interval_days"]
        if rating == "again":
            interval = 1
        elif data["repetitions"] == 0:
            interval = 1 if rating == "good" else 4
        else:
            interval = min(365, previous * (2 if rating == "good" else 3))
        now = int(time.time())
        data.update(interval_days=interval, repetitions=min(1000, data["repetitions"] + 1), due=now + interval * 86400)
        db.execute("UPDATE training_entries SET data=?,revision=revision+1,updated=? WHERE id=?",
                   (_encode(data), now, entry_id))
        return _entry(_find_entry(db, username, "lessons", entry_id))


def _list(db, username, kind, team_id=None, offset=0, limit=PAGE_SIZE):
    scope, value = ("team_id=?", team_id) if team_id is not None else ("team_id IS NULL AND owner=?", username)
    rows = db.execute(f"SELECT * FROM training_entries WHERE {scope} AND kind=? ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?",
                      (value, kind, limit + 1, offset)).fetchall()
    return {"entries": [_entry(row) for row in rows[:limit]], "has_more": len(rows) > limit}


class Pagination(StrictModel):
    offset: Annotated[int, Field(ge=0, le=MAX_MEMBER_ENTRIES)]
    limit: Annotated[int, Field(ge=1, le=PAGE_SIZE)]


def list_entries(username, kind, team_id=None, offset=0, limit=PAGE_SIZE):
    _kind(kind)
    _model(Pagination, {"offset": offset, "limit": limit})
    if team_id is not None:
        _model(TeamScope, {"team_id": team_id})
    with _transaction(username) as db:
        if team_id is not None:
            _team(db, username, team_id)
        return _list(db, username, kind, team_id, offset, limit)


def workspace(username):
    with _transaction(username) as db:
        pages = {kind: _list(db, username, kind) for kind in KINDS}
        teams = [_team_record(db, row) for row in db.execute(
            """SELECT t.* FROM training_teams t JOIN training_memberships m ON t.id=m.team_id
               WHERE m.username=? AND m.status='active' ORDER BY t.created DESC,t.id DESC""", (username,))]
        invitations = [dict(row) for row in db.execute(
            """SELECT t.id AS team_id,t.name AS team_name,t.owner,m.created FROM training_teams t
               JOIN training_memberships m ON t.id=m.team_id WHERE m.username=? AND m.status='invited'
               ORDER BY m.created DESC,t.id DESC""", (username,))]
        count = _member_entry_count(db, username)
        personal = db.execute("SELECT COUNT(*) FROM training_entries WHERE owner=? AND team_id IS NULL", (username,)).fetchone()[0]
        return {"catalog": {"workouts": copy.deepcopy(WORKOUTS), "starter_puzzles": copy.deepcopy(STARTER_PUZZLES)},
                "entries": {kind: page["entries"] for kind, page in pages.items()}, "teams": teams, "invitations": invitations,
                "limits": {"per_member": MAX_MEMBER_ENTRIES, "per_team": MAX_TEAM_ENTRIES,
                           "teams_per_member": MAX_MEMBER_TEAMS, "members_per_team": MAX_TEAM_MEMBERS,
                           "entry_bytes": MAX_ENTRY_BYTES, "page_size": PAGE_SIZE,
                           "member_count": count, "personal_count": personal, "remaining": max(0, MAX_MEMBER_ENTRIES - count),
                           "has_more": {kind: page["has_more"] for kind, page in pages.items()}}}


def export_member(username):
    with _transaction(username) as db:
        entries = {kind: [] for kind in KINDS}
        for row in db.execute("SELECT * FROM training_entries WHERE owner=? AND team_id IS NULL ORDER BY created,rowid", (username,)):
            entries[row["kind"]].append(_entry(row))
        links = []
        for row in db.execute(
                """SELECT l.* FROM training_plan_links l JOIN training_entries e ON e.id=l.plan_id
                   WHERE l.owner=? AND e.owner=? AND e.team_id IS NULL AND e.kind='plans'
                   ORDER BY l.started,l.plan_id""", (username, username)):
            link = dict(row)
            link["baseline_ids"] = json.loads(link["baseline_ids"])
            links.append(link)
        result = {"version": 1, "username": username, "exported": int(time.time()), "entries": entries}
        if links:
            result["tracking"] = links
        return result


class TeamName(StrictModel):
    name: Title


class Invite(StrictModel):
    username: Username


def _membership_count(db, username):
    return db.execute("SELECT COUNT(*) FROM training_memberships WHERE username=?", (username,)).fetchone()[0]


def create_team(username, name):
    name = _model(TeamName, {"name": name})["name"]
    with _transaction(username, write=True) as db:
        if _membership_count(db, username) >= MAX_MEMBER_TEAMS:
            raise Error(409, "Team limit reached; leave a team or decline an invitation first")
        team_id, now = uuid.uuid4().hex, int(time.time())
        db.execute("INSERT INTO training_teams VALUES (?,?,?,?)", (team_id, name, username, now))
        db.execute("INSERT INTO training_memberships VALUES (?,?,'active',?)", (team_id, username, now))
        return _team_record(db, _team(db, username, team_id))


def invite_member(username, team_id, invited_username):
    _model(Invite, {"username": invited_username})
    with _transaction(username, write=True) as db:
        team = _team(db, username, team_id)
        if team["owner"] != username:
            raise Error(403, "Only the team owner can invite members")
        if not db.execute("SELECT 1 FROM users WHERE username=?", (invited_username,)).fetchone():
            raise Error(404, "Member not found")
        if db.execute("SELECT 1 FROM training_memberships WHERE team_id=? AND username=?", (team_id, invited_username)).fetchone():
            return {"ok": True}  # Re-inviting never changes acceptance or creates duplicates.
        if db.execute("SELECT COUNT(*) FROM training_memberships WHERE team_id=?", (team_id,)).fetchone()[0] >= MAX_TEAM_MEMBERS:
            raise Error(409, "Team member/invitation limit reached")
        if _membership_count(db, invited_username) >= MAX_MEMBER_TEAMS:
            raise Error(409, "Member cannot receive another team invitation")
        db.execute("INSERT INTO training_memberships VALUES (?,?,'invited',?)", (team_id, invited_username, int(time.time())))
    return {"ok": True}


def accept_invitation(username, team_id):
    with _transaction(username, write=True) as db:
        _team(db, username, team_id, invited=True)
        db.execute("UPDATE training_memberships SET status='active' WHERE team_id=? AND username=?", (team_id, username))
        return _team_record(db, _team(db, username, team_id))


def remove_member(username, team_id, removed_username):
    with _transaction(username, write=True) as db:
        team = _team(db, username, team_id, invited=True)
        if username != team["owner"] and username != removed_username:
            raise Error(403, "Only the owner can remove another member")
        if removed_username == team["owner"]:
            raise Error(409, "The owner must delete the team rather than leave")
        if not db.execute("SELECT 1 FROM training_memberships WHERE team_id=? AND username=?", (team_id, removed_username)).fetchone():
            raise Error(404, "Membership not found")
        db.execute("DELETE FROM training_memberships WHERE team_id=? AND username=?", (team_id, removed_username))
    return {"ok": True}


def delete_team(username, team_id):
    with _transaction(username, write=True) as db:
        team = _team(db, username, team_id)
        if team["owner"] != username:
            raise Error(403, "Only the owner can delete the team")
        db.execute("DELETE FROM training_teams WHERE id=?", (team_id,))
    return {"ok": True}


def get_team(username, team_id):
    with _transaction(username) as db:
        team = _team_record(db, _team(db, username, team_id))
        pages = {kind: _list(db, username, kind, team_id) for kind in TEAM_KINDS}
        return {"team": team, "entries": {kind: page["entries"] for kind, page in pages.items()},
                "has_more": {kind: page["has_more"] for kind, page in pages.items()}}


def erase_member(db, username):
    """Erase training data without initializing schema, committing or toggling FKs.

    Explicit cascades are essential on auth's FK-off CLI connection. Call before
    deleting the users row, inside the same BEGIN IMMEDIATE transaction; rollback
    remains possible. Do not call for Riot unlink. Import training locally in the
    auth removal branch to avoid a top-level auth/training import cycle.
    """
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'training_%'")}
    if "training_plan_links" in tables:
        db.execute("DELETE FROM training_plan_links WHERE owner=?", (username,))
        if "training_entries" in tables:
            db.execute("""DELETE FROM training_plan_links WHERE plan_id IN
                          (SELECT id FROM training_entries WHERE owner=?)""", (username,))
    if "training_teams" in tables:
        if "training_entries" in tables:
            db.execute("DELETE FROM training_entries WHERE team_id IN (SELECT id FROM training_teams WHERE owner=?)", (username,))
        if "training_memberships" in tables:
            db.execute("DELETE FROM training_memberships WHERE team_id IN (SELECT id FROM training_teams WHERE owner=?)", (username,))
        db.execute("DELETE FROM training_teams WHERE owner=?", (username,))
    if "training_entries" in tables:
        rows = [dict(zip(("id", "kind", "owner", "team_id"), row)) for row in db.execute(
            "SELECT id,kind,owner,team_id FROM training_entries WHERE owner=?", (username,))]
        _clear_references(db, rows)
        db.execute("DELETE FROM training_entries WHERE owner=?", (username,))
    if "training_memberships" in tables:
        db.execute("DELETE FROM training_memberships WHERE username=?", (username,))
