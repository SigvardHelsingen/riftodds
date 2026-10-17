"""Authenticated, same-origin JSON API for the private training workspace.

Include ``router`` in the existing app; authentication remains in its middleware
and must set request.state.user to the authenticated member's username. Keep the
external scheme/host accurate behind a trusted proxy for same-origin checks.
The bounded body parser is intentionally independent of the app's validation-error
handler so even tiny fixture apps cannot echo NaN, secrets, or enormous bodies.
Storage handlers are synchronous so FastAPI keeps SQLite work off the event loop.
"""
import json
import sqlite3
from typing import Annotated, NoReturn
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import ValidationError

import training
import training_matches

MAX_REQUEST_BYTES = 40 * 1024
PRIVATE_HEADERS = {"Cache-Control": "no-store, private", "Vary": "Cookie"}


def _error(status, detail) -> NoReturn:
    raise HTTPException(status, detail, headers=PRIVATE_HEADERS)


def _origin(value, allow_path=False):
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.fragment or any(c.isspace() for c in value)
                or (not allow_path and (parsed.query or parsed.path))):
            return None
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
        return parsed.scheme.lower(), parsed.hostname.lower(), port
    except ValueError:
        return None


async def _guard(request: Request, response: Response):
    username = getattr(request.state, "user", None)
    if not isinstance(username, str) or not username:
        _error(401, "Not logged in")
    for key, value in PRIVATE_HEADERS.items():
        response.headers[key] = value
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        expected = _origin(f"{request.url.scheme}://{request.url.netloc}")
        origins = request.headers.getlist("origin")
        if origins:
            if len(origins) != 1 or _origin(origins[0]) is None or _origin(origins[0]) != expected:
                _error(403, "Cross-origin training mutations are not allowed")
        elif "referer" in request.headers:
            referers = request.headers.getlist("referer")
            if len(referers) != 1 or _origin(referers[0], allow_path=True) != expected:
                _error(403, "Cross-origin training mutations are not allowed")
        if request.headers.get("sec-fetch-site", "").lower() in ("cross-site", "same-site"):
            _error(403, "Cross-origin training mutations are not allowed")
    route = request.scope["route"].path
    allowed_query = set()
    if request.method == "GET" and route.endswith("/entries/{kind}"):
        allowed_query = {"team_id", "offset", "limit"}
    elif request.method == "DELETE" and (route.endswith("/entries/{kind}/{entry_id}")
                                         or route.endswith("/plans/{plan_id}/matches")):
        allowed_query = {"revision"}
    elif request.method == "GET" and route.endswith("/review-queue"):
        allowed_query = {"plan_id"}
    if any(key not in allowed_query or len(request.query_params.getlist(key)) != 1 for key in request.query_params):
        _error(422, "Unknown or duplicate query fields")
    return username


User = Annotated[str, Depends(_guard)]
router = APIRouter(prefix="/api/training", tags=["training"])


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError("Nonfinite JSON number")


async def _body(request: Request):
    content_types = request.headers.getlist("content-type")
    if len(content_types) != 1 or content_types[0].split(";", 1)[0].strip().lower() != "application/json":
        _error(415, "Use application/json")
    lengths = request.headers.getlist("content-length")
    if lengths:
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            _error(400, "Invalid Content-Length")
        # Length text is checked before int conversion (which itself has a digit limit).
        if len(lengths[0]) > 8 or int(lengths[0]) > MAX_REQUEST_BYTES:
            _error(413, "Training request exceeds the 40 KiB limit")
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_REQUEST_BYTES:
            _error(413, "Training request exceeds the 40 KiB limit")
        raw.extend(chunk)
    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        _error(422, "Invalid JSON object")
    if not isinstance(result, dict):
        _error(422, "Expected a JSON object")
    return result


Body = Annotated[dict, Depends(_body)]


class CreateEntry(training.StrictModel):
    data: dict
    team_id: training.Identifier | None = None


class ReplaceEntry(training.RevisionBody):
    data: dict


class Empty(training.StrictModel):
    pass


def _validated(model, data):
    try:
        return model.model_validate(data)
    except ValidationError:
        # A stable sanitized error, independent of the host application's handlers.
        _error(422, "Invalid request fields or types")


def _query_integer(value: str | None, minimum: int, maximum: int, default: int | None = None) -> int:
    # Query strings are text, but decimal/exponent/whitespace coercions are not
    # revisions or pagination integers. Bound digit count before int conversion.
    if value is None and default is not None:
        return default
    if (not isinstance(value, str) or not value.isascii() or not value.isdigit()
            or len(value) > len(str(maximum))):
        _error(422, "Invalid query fields or types")
    number = int(value)
    if not minimum <= number <= maximum:
        _error(422, "Invalid query fields or types")
    return number


def _call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except training.Error as error:
        _error(error.status, error.detail)
    except sqlite3.OperationalError:
        _error(503, "Training storage is temporarily unavailable; retry shortly")


@router.get("")
def workspace(user: User):
    return _call(training.workspace, user)


@router.get("/matches/options")
def match_options(user: User):
    return _call(training_matches.options, user)


@router.get("/plans/{plan_id}/matches")
def match_progress(plan_id: str, user: User):
    return _call(training_matches.progress, user, plan_id)


@router.post("/plans/{plan_id}/matches")
def start_matches(plan_id: str, user: User, body: Body):
    validated = _validated(training_matches.StartTracking, body)
    return _call(training_matches.start, user, plan_id, validated.model_dump())


@router.delete("/plans/{plan_id}/matches")
def stop_matches(plan_id: str, user: User, revision: Annotated[str | None, Query()] = None):
    parsed_revision = _query_integer(revision, 1, training.MAX_REVISION)
    return _call(training_matches.stop, user, plan_id, parsed_revision)


@router.get("/review-queue")
def review_queue(user: User, plan_id: Annotated[str | None, Query()] = None):
    if plan_id is not None:
        plan_id = _validated(training.TeamScope, {"team_id": plan_id}).team_id
    return _call(training_matches.review_queue, user, plan_id)


@router.get("/review-context/{match_id}")
def review_context(match_id: str, user: User):
    return _call(training_matches.review_context, user, match_id)


@router.get("/export")
def export(user: User, response: Response):
    response.headers["Content-Disposition"] = 'attachment; filename="rift-odds-training.json"'
    return _call(training.export_member, user)


@router.get("/entries/{kind}")
def entries(kind: str, user: User, team_id: Annotated[str | None, Query()] = None,
            offset: Annotated[str | None, Query()] = None, limit: Annotated[str | None, Query()] = None):
    parsed_offset = _query_integer(offset, 0, training.MAX_MEMBER_ENTRIES, default=0)
    parsed_limit = _query_integer(limit, 1, training.PAGE_SIZE, default=training.PAGE_SIZE)
    if team_id is not None:
        team_id = _validated(training.TeamScope, {"team_id": team_id}).team_id
    return _call(training.list_entries, user, kind, team_id, parsed_offset, parsed_limit)


@router.post("/entries/{kind}")
def create_entry(kind: str, user: User, body: Body):
    validated = _validated(CreateEntry, body)
    return {"entry": _call(training.create_entry, user, kind, validated.data, validated.team_id)}


@router.put("/entries/{kind}/{entry_id}")
def replace_entry(kind: str, entry_id: str, user: User, body: Body):
    validated = _validated(ReplaceEntry, body)
    return {"entry": _call(training.update_entry, user, kind, entry_id, validated.data, validated.revision)}


@router.delete("/entries/{kind}/{entry_id}")
def delete_entry(kind: str, entry_id: str, user: User, revision: Annotated[str | None, Query()] = None):
    parsed_revision = _query_integer(revision, 1, training.MAX_REVISION)
    return _call(training.delete_entry, user, kind, entry_id, parsed_revision)


@router.post("/lessons/{entry_id}/grade")
def grade(entry_id: str, user: User, body: Body):
    validated = _validated(training.Grade, body)
    return {"entry": _call(training.grade_lesson, user, entry_id, validated.revision, validated.rating)}


@router.post("/teams")
def create_team(user: User, body: Body):
    validated = _validated(training.TeamName, body)
    return {"team": _call(training.create_team, user, validated.name)}


@router.get("/teams/{team_id}")
def get_team(team_id: str, user: User):
    return _call(training.get_team, user, team_id)


@router.post("/teams/{team_id}/invite")
def invite(team_id: str, user: User, body: Body):
    validated = _validated(training.Invite, body)
    return _call(training.invite_member, user, team_id, validated.username)


@router.post("/teams/{team_id}/accept")
def accept(team_id: str, user: User, body: Body):
    _validated(Empty, body)
    return {"team": _call(training.accept_invitation, user, team_id)}


@router.delete("/teams/{team_id}/members/{username}")
def remove_member(team_id: str, username: str, user: User):
    return _call(training.remove_member, user, team_id, username)


@router.delete("/teams/{team_id}")
def delete_team(team_id: str, user: User):
    return _call(training.delete_team, user, team_id)
