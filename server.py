from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from flask import Flask, jsonify, request, send_from_directory
from redis import Redis
from redis.exceptions import WatchError

BASE_DIR = Path(__file__).resolve().parent
ADMIN_CODE = os.getenv("ADMIN_CODE", "admin123")
PORT = int(os.getenv("PORT", "3000"))
TIMER_SECONDS = 5 * 60
PLAYER_TIMEOUT_SECONDS = 120
STATE_KEY = os.getenv("STATE_KEY", "funquest:state:v1")
REDIS_URL = (
    os.getenv("REDIS_URL")
    or os.getenv("KV_URL")
    or os.getenv("UPSTASH_REDIS_URL")
    or ""
).strip()

Question = dict[str, str]
GameState = dict[str, Any]


def now_ms() -> int:
    return int(time.time() * 1000)


def load_questions() -> list[Question]:
    source = (BASE_DIR / "riddle_bank.js").read_text(encoding="utf-8")
    pattern = re.compile(r'\{\s*clue:\s*"((?:\\.|[^"])*)",\s*answer:\s*"((?:\\.|[^"])*)"\s*\}')
    questions: list[Question] = []

    for clue_raw, answer_raw in pattern.findall(source):
        clue = bytes(clue_raw, "utf-8").decode("unicode_escape")
        answer = bytes(answer_raw, "utf-8").decode("unicode_escape")
        questions.append({"clue": clue, "answer": answer})

    if not questions:
        raise RuntimeError("No questions loaded from riddle_bank.js")
    return questions


QUESTIONS = load_questions()


def default_state() -> GameState:
    return {
        "schemaVersion": 1,
        "adminToken": None,
        "gameStarted": False,
        "gameFinished": False,
        "questionIndex": -1,
        "questionStartedAt": None,
        "revealAnswer": False,
        "players": {},
    }


def normalize_state(raw: Any) -> GameState:
    state = default_state()
    if isinstance(raw, dict):
        state.update(raw)

    players = state.get("players")
    if not isinstance(players, dict):
        state["players"] = {}
    else:
        clean_players = {}
        for pid, player in players.items():
            if not isinstance(player, dict):
                continue
            name = player.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            clean_players[pid] = {
                "id": pid,
                "name": " ".join(name.strip().split())[:24],
                "score": int(player.get("score", 0)),
                "answers": player.get("answers", {}) if isinstance(player.get("answers"), dict) else {},
                "lastSeen": int(player.get("lastSeen", 0)),
            }
        state["players"] = clean_players

    return state


class StateStore:
    backend_name = "memory"

    def mutate(self, fn: Callable[[GameState], Any]) -> Any:
        raise NotImplementedError


class LocalStateStore(StateStore):
    backend_name = "memory"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = default_state()

    def mutate(self, fn: Callable[[GameState], Any]) -> Any:
        with self._lock:
            return fn(self._state)


class RedisStateStore(StateStore):
    backend_name = "redis"

    def __init__(self, redis_url: str, state_key: str) -> None:
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self.state_key = state_key

    def mutate(self, fn: Callable[[GameState], Any]) -> Any:
        for _ in range(8):
            with self.redis.pipeline() as pipe:
                try:
                    pipe.watch(self.state_key)
                    raw = pipe.get(self.state_key)
                    state = normalize_state(json.loads(raw) if raw else {})

                    result = fn(state)

                    pipe.multi()
                    pipe.set(self.state_key, json.dumps(state, separators=(",", ":"), ensure_ascii=False))
                    pipe.execute()
                    return result
                except WatchError:
                    continue
        raise RuntimeError("High concurrency: unable to update game state. Please retry.")


if REDIS_URL:
    STORE: StateStore = RedisStateStore(REDIS_URL, STATE_KEY)
else:
    STORE = LocalStateStore()

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path="")


def safe_name(raw: Any) -> str:
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.strip().split())[:24]


def safe_answer(raw: Any) -> str:
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.strip().split())[:180]


def cleanup_players(state: GameState) -> None:
    cutoff = now_ms() - (PLAYER_TIMEOUT_SECONDS * 1000)
    stale_ids = [
        pid
        for pid, player in state["players"].items()
        if int(player.get("lastSeen", 0)) < cutoff
    ]
    for pid in stale_ids:
        state["players"].pop(pid, None)


def sorted_players(state: GameState) -> list[dict[str, Any]]:
    return sorted(
        state["players"].values(),
        key=lambda p: (-int(p.get("score", 0)), str(p.get("name", "")).lower()),
    )


def current_question(state: GameState) -> Question | None:
    idx = int(state.get("questionIndex", -1))
    if idx < 0 or idx >= len(QUESTIONS):
        return None
    return QUESTIONS[idx]


def leaderboard(state: GameState) -> list[dict[str, Any]]:
    return [
        {"id": p["id"], "name": p["name"], "score": int(p.get("score", 0))}
        for p in sorted_players(state)
    ]


def common_state(state: GameState) -> dict[str, Any]:
    question = current_question(state)
    q_idx = int(state.get("questionIndex", -1))
    return {
        "gameStarted": bool(state.get("gameStarted")),
        "gameFinished": bool(state.get("gameFinished")),
        "questionIndex": q_idx,
        "questionNumber": q_idx + 1 if q_idx >= 0 else 0,
        "totalQuestions": len(QUESTIONS),
        "questionText": question["clue"] if question else None,
        "revealAnswer": bool(state.get("revealAnswer")),
        "revealedAnswer": question["answer"] if (state.get("revealAnswer") and question) else None,
        "questionStartedAt": state.get("questionStartedAt"),
        "timerSeconds": TIMER_SECONDS,
        "playersOnline": len(state["players"]),
        "leaderboard": leaderboard(state),
    }


def player_state(state: GameState, player_id: str) -> dict[str, Any] | None:
    player = state["players"].get(player_id)
    if not player:
        return None

    data = common_state(state)
    q_key = str(int(state.get("questionIndex", -1)))
    current_answer = player["answers"].get(q_key)
    data.update(
        {
            "you": {"id": player["id"], "name": player["name"], "score": int(player.get("score", 0))},
            "submittedCurrent": bool(current_answer),
            "yourCurrentAnswer": current_answer["answer"] if current_answer else "",
            "canSubmit": bool(
                state.get("gameStarted")
                and int(state.get("questionIndex", -1)) >= 0
                and not state.get("revealAnswer")
                and not current_answer
            ),
        }
    )
    return data


def admin_state(state: GameState) -> dict[str, Any]:
    data = common_state(state)
    question = current_question(state)
    q_key = str(int(state.get("questionIndex", -1)))
    rows = []
    for player in sorted_players(state):
        current_answer = player["answers"].get(q_key)
        rows.append(
            {
                "id": player["id"],
                "name": player["name"],
                "score": int(player.get("score", 0)),
                "totalSubmissions": len(player.get("answers", {})),
                "submittedCurrent": bool(current_answer),
                "currentAnswer": current_answer["answer"] if current_answer else "",
                "currentPoints": current_answer.get("points") if current_answer else None,
            }
        )
    data.update(
        {
            "answerForAdmin": question["answer"] if question else None,
            "players": rows,
        }
    )
    return data


def is_admin(state: GameState, token: str | None) -> bool:
    return bool(token) and token == state.get("adminToken")


def reset_game(state: GameState) -> None:
    state["gameStarted"] = False
    state["gameFinished"] = False
    state["questionIndex"] = -1
    state["questionStartedAt"] = None
    state["revealAnswer"] = False
    for player in state["players"].values():
        player["score"] = 0
        player["answers"] = {}


def start_question(state: GameState, index: int) -> bool:
    if index < 0 or index >= len(QUESTIONS):
        return False
    state["gameStarted"] = True
    state["gameFinished"] = False
    state["questionIndex"] = index
    state["questionStartedAt"] = now_ms()
    state["revealAnswer"] = False
    return True


def mutate_or_503(fn: Callable[[GameState], tuple[dict[str, Any], int]]) -> tuple[Any, int]:
    try:
        payload, status = STORE.mutate(fn)
        return jsonify(payload), status
    except Exception as exc:  # broad fallback so game never crashes on a request
        return jsonify({"ok": False, "error": f"State backend error: {exc}"}), 503


@app.get("/")
def index_page():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/admin.html")
def admin_page():
    return send_from_directory(BASE_DIR, "admin.html")


@app.get("/health")
def health():
    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        cleanup_players(state)
        return (
            {
                "ok": True,
                "backend": STORE.backend_name,
                "playersOnline": len(state["players"]),
                "gameStarted": bool(state.get("gameStarted")),
                "questionNumber": int(state.get("questionIndex", -1)) + 1,
                "totalQuestions": len(QUESTIONS),
            },
            200,
        )

    return mutate_or_503(operation)


@app.get("/admin.html/health")
def health_alias_admin_html():
    # Alias so accidental nested URL checks still return service health.
    return health()


@app.get("/admin/health")
def health_alias_admin():
    return health()


@app.post("/api/player/join")
def api_player_join():
    payload = request.get_json(silent=True) or {}
    name = safe_name(payload.get("name"))
    if not name:
        return jsonify({"ok": False, "error": "Please type a valid player name."}), 400

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        cleanup_players(state)
        player_id = uuid.uuid4().hex[:12]
        state["players"][player_id] = {
            "id": player_id,
            "name": name,
            "score": 0,
            "answers": {},
            "lastSeen": now_ms(),
        }
        return {"ok": True, "playerId": player_id}, 200

    return mutate_or_503(operation)


@app.get("/api/player/state")
def api_player_state():
    player_id = request.args.get("playerId", "")

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        cleanup_players(state)
        player = state["players"].get(player_id)
        if not player:
            return {"ok": False, "error": "Player session not found. Please rejoin."}, 404
        player["lastSeen"] = now_ms()
        return {"ok": True, "state": player_state(state, player_id)}, 200

    return mutate_or_503(operation)


@app.post("/api/player/answer")
def api_player_answer():
    payload = request.get_json(silent=True) or {}
    player_id = payload.get("playerId", "")
    answer = safe_answer(payload.get("answer"))

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        cleanup_players(state)
        player = state["players"].get(player_id)
        if not player:
            return {"ok": False, "error": "Player session not found. Please rejoin."}, 404
        player["lastSeen"] = now_ms()

        if not state.get("gameStarted") or int(state.get("questionIndex", -1)) < 0:
            return {"ok": False, "error": "Wait for admin to start the game."}, 400
        if state.get("revealAnswer"):
            return {"ok": False, "error": "Answer is already revealed. Submissions are closed."}, 400
        if not answer:
            return {"ok": False, "error": "Please type your answer first."}, 400

        q_key = str(int(state["questionIndex"]))
        if q_key in player["answers"]:
            return {"ok": False, "error": "No resubmission for this question."}, 400

        player["answers"][q_key] = {
            "answer": answer,
            "points": None,
            "submittedAt": now_ms(),
        }
        return {"ok": True}, 200

    return mutate_or_503(operation)


@app.post("/api/admin/login")
def api_admin_login():
    payload = request.get_json(silent=True) or {}
    code = payload.get("code")
    if code != ADMIN_CODE:
        return jsonify({"ok": False, "error": "Wrong admin code."}), 401

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        token = uuid.uuid4().hex
        state["adminToken"] = token
        return {"ok": True, "token": token}, 200

    return mutate_or_503(operation)


@app.get("/api/admin/state")
def api_admin_state():
    token = request.args.get("token", "")

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        cleanup_players(state)
        if not is_admin(state, token):
            return {"ok": False, "error": "Admin session expired. Login again."}, 401
        return {"ok": True, "state": admin_state(state)}, 200

    return mutate_or_503(operation)


@app.post("/api/admin/start")
def api_admin_start():
    payload = request.get_json(silent=True) or {}
    token = payload.get("token")

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        if not is_admin(state, token):
            return {"ok": False, "error": "Only admin can do this."}, 401
        cleanup_players(state)
        reset_game(state)
        start_question(state, 0)
        return {"ok": True}, 200

    return mutate_or_503(operation)


@app.post("/api/admin/reveal")
def api_admin_reveal():
    payload = request.get_json(silent=True) or {}
    token = payload.get("token")

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        if not is_admin(state, token):
            return {"ok": False, "error": "Only admin can do this."}, 401
        if not state.get("gameStarted") or int(state.get("questionIndex", -1)) < 0:
            return {"ok": False, "error": "Start the game first."}, 400
        state["revealAnswer"] = True
        return {"ok": True}, 200

    return mutate_or_503(operation)


@app.post("/api/admin/next")
def api_admin_next():
    payload = request.get_json(silent=True) or {}
    token = payload.get("token")

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        if not is_admin(state, token):
            return {"ok": False, "error": "Only admin can do this."}, 401
        if not state.get("gameStarted"):
            return {"ok": False, "error": "Game is not active."}, 400

        if int(state.get("questionIndex", -1)) >= len(QUESTIONS) - 1:
            state["gameStarted"] = False
            state["gameFinished"] = True
            state["revealAnswer"] = True
            return {"ok": True, "finished": True}, 200

        start_question(state, int(state.get("questionIndex", -1)) + 1)
        return {"ok": True, "finished": False}, 200

    return mutate_or_503(operation)


@app.post("/api/admin/mark")
def api_admin_mark():
    payload = request.get_json(silent=True) or {}
    token = payload.get("token")
    player_id = payload.get("playerId")
    raw_points = payload.get("points", 0)

    def operation(state: GameState) -> tuple[dict[str, Any], int]:
        if not is_admin(state, token):
            return {"ok": False, "error": "Only admin can do this."}, 401

        player = state["players"].get(player_id)
        if not player:
            return {"ok": False, "error": "Player not found."}, 404
        if int(state.get("questionIndex", -1)) < 0:
            return {"ok": False, "error": "No active question."}, 400

        q_key = str(int(state["questionIndex"]))
        answer_record = player["answers"].get(q_key)
        if not answer_record:
            return {"ok": False, "error": "This player has not submitted yet."}, 400

        try:
            points = int(raw_points)
        except (TypeError, ValueError):
            points = 0
        points = max(-2, min(10, points))

        prev = answer_record["points"] if isinstance(answer_record.get("points"), int) else 0
        answer_record["points"] = points
        player["score"] = int(player.get("score", 0)) + (points - prev)
        return {"ok": True}, 200

    return mutate_or_503(operation)


if __name__ == "__main__":
    print(f"Fun Quest (Python) running at http://localhost:{PORT}")
    print(f"Player portal: http://localhost:{PORT}")
    print(f"Admin portal: http://localhost:{PORT}/admin.html")
    print(f"Admin code: {ADMIN_CODE}")
    if REDIS_URL:
        print("State backend: Redis")
    else:
        print("State backend: In-memory (local only)")
    app.run(host="0.0.0.0", port=PORT, debug=False)
