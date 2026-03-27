"""Data coordinator for the Adler Mannheim integration."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    ADLER_CLUB_ID,
    API_TIMEOUT,
    BASE_URL,
    DOMAIN,
    EVENT_GAME_END,
    EVENT_GAME_START,
    EVENT_GOAL,
    EVENT_PENALTY,
    EVENT_PERIOD_END,
    UPDATE_INTERVAL_APPROACHING,
    UPDATE_INTERVAL_IDLE,
    UPDATE_INTERVAL_LIVE,
    UPDATE_INTERVAL_PRE_GAME,
)

_LOGGER = logging.getLogger(__name__)

try:
    from aiohttp import ClientTimeout
    _TIMEOUT = ClientTimeout(total=API_TIMEOUT)
except ImportError:
    _TIMEOUT = None

_SUMMARY_KEYS = (
    "homeclubid", "awayclubid", "homelogoid", "awaylogoid",
    "homelogourl", "awaylogourl", "hometeam_short", "awayteam_short",
)


def format_scorer(player: dict | None) -> str | None:
    """Format a player name from the API player object."""
    if not player or not player.get("id"):
        return None
    first = player.get("firstname") or ""
    last = player.get("lastname") or ""
    name = f"{first} {last}".strip()
    return name or None


def _parse_matchstart(matchstart: str | None) -> datetime | None:
    """Parse a matchstart string into a timezone-aware datetime."""
    if not matchstart:
        return None
    try:
        return datetime.strptime(matchstart, "%Y-%m-%d %H:%M:%S %z")
    except (ValueError, TypeError):
        return None


def _format_local(matchstart: str | None) -> str | None:
    """Format a matchstart UTC string in the HA-configured local timezone."""
    dt = _parse_matchstart(matchstart)
    if not dt:
        return matchstart
    return dt_util.as_local(dt).isoformat()


def _is_adler_home(game: dict) -> bool:
    """Check if Adler is the home team."""
    return game.get("homeclubid") == ADLER_CLUB_ID or "Adler" in (game.get("hometeam") or "")


def _adler_score(game: dict) -> tuple[int, int]:
    """Return (adler_score, opponent_score) for a game."""
    h = game.get("homescore", 0) or 0
    a = game.get("awayscore", 0) or 0
    if _is_adler_home(game):
        return h, a
    return a, h


class AdlerMannheimCoordinator(DataUpdateCoordinator):
    """Coordinator that fetches Adler Mannheim game data."""

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(
            hass, _LOGGER, name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL_IDLE),
        )
        self._current_game_id: int | None = None
        self._known_goal_ids: set[int] = set()
        self._known_penalty_ids: set[int] = set()
        self._known_periods: int = 0
        self._was_live: bool = False

    async def _async_update_data(self) -> dict:
        """Fetch game data from the Adler Mannheim API."""
        session = async_get_clientsession(self.hass)

        try:
            kw = {"timeout": _TIMEOUT} if _TIMEOUT else {}
            async with session.get(BASE_URL, **kw) as resp:
                if resp.status != 200:
                    raise UpdateFailed(f"API returned {resp.status}")
                games = await resp.json()
        except UpdateFailed:
            raise
        except Exception as err:
            raise UpdateFailed(f"Error fetching games: {err}") from err

        # Categorize games
        finished = sorted(
            (g for g in games if g.get("status") == "FINAL"),
            key=lambda x: x.get("matchstart", ""), reverse=True,
        )
        running = [g for g in games if g.get("status") == "LIVE"]
        future = sorted(
            (g for g in games if g.get("status") == "FUTURE"),
            key=lambda x: x.get("matchstart", ""),
        )

        last_summary = finished[0] if finished else None
        current_summary = running[0] if running else None
        next_summary = future[0] if future else None

        async def fetch_detail(summary: dict | None) -> dict | None:
            if not summary:
                return None
            gid = summary.get("id")
            if not gid:
                return summary
            try:
                async with session.get(f"{BASE_URL}{gid}", **kw) as resp:
                    if resp.status == 200:
                        detail = await resp.json()
                        for key in _SUMMARY_KEYS:
                            if key in summary and key not in detail:
                                detail[key] = summary[key]
                        return detail
            except Exception as err:
                _LOGGER.warning("Failed to fetch detail for game %s: %s", gid, err)
            return summary

        last_game, current_game, next_game = await asyncio.gather(
            fetch_detail(last_summary),
            fetch_detail(current_summary),
            fetch_detail(next_summary),
        )

        # Compute season stats from all games
        season_stats = self._compute_season_stats(games)
        playoff_series = self._compute_playoff_series(games)
        game_stats = self._extract_game_stats(current_game or last_game)

        # Adjust polling interval
        is_live = current_game is not None
        new_interval = self._calculate_interval(is_live, next_game or next_summary)
        if self.update_interval != timedelta(seconds=new_interval):
            self.update_interval = timedelta(seconds=new_interval)

        # Detect events
        self._detect_events(current_game, current_summary)

        return {
            "last_game": last_game,
            "current_game": current_game,
            "next_game": next_game,
            "is_live": is_live,
            "season_stats": season_stats,
            "playoff_series": playoff_series,
            "game_stats": game_stats,
            "all_games": games,
        }

    # ── Season stats ──────────────────────────────────────

    @staticmethod
    def _compute_season_stats(games: list[dict]) -> dict:
        """Compute W/L/OTL record and stats from all finished DEL games."""
        wins = losses = otl = 0
        gf = ga = 0
        home_w = home_l = home_otl = 0
        away_w = away_l = away_otl = 0
        results = []  # list of (matchstart, "W"/"L"/"OTL", opponent, score)

        del_games = [
            g for g in games
            if g.get("status") == "FINAL" and g.get("competitiontype") == "DEL"
        ]

        for g in del_games:
            adler_home = _is_adler_home(g)
            a_score, o_score = _adler_score(g)
            gf += a_score
            ga += o_score
            went_ot = (g.get("periods", 3) or 3) > 3
            opponent = g.get("awayteam") if adler_home else g.get("hometeam")

            if a_score > o_score:
                wins += 1
                res = "W"
                if adler_home:
                    home_w += 1
                else:
                    away_w += 1
            elif went_ot:
                otl += 1
                res = "OTL"
                if adler_home:
                    home_otl += 1
                else:
                    away_otl += 1
            else:
                losses += 1
                res = "L"
                if adler_home:
                    home_l += 1
                else:
                    away_l += 1

            results.append({
                "date": g.get("matchstart", ""),
                "result": res,
                "opponent": opponent,
                "score": f"{a_score}:{o_score}",
                "is_home": adler_home,
            })

        # Sort results by date
        results.sort(key=lambda x: x["date"])

        # DEL points: 3 for regulation W, 2 for OT/SO W, 1 for OTL, 0 for regulation L
        # Simplified: we can't reliably distinguish OT-win from regulation-win
        # from list data alone. Use 3 per win, 1 per OTL.
        points = wins * 3 + otl * 1

        # Current streak
        streak_type = ""
        streak_count = 0
        for r in reversed(results):
            if not streak_type:
                streak_type = r["result"]
                streak_count = 1
            elif r["result"] == streak_type:
                streak_count += 1
            else:
                break
        streak = f"{streak_type}{streak_count}" if streak_type else ""

        # Last 5 results
        last5 = [r["result"] for r in results[-5:]]

        total = wins + losses + otl

        return {
            "wins": wins,
            "losses": losses,
            "otl": otl,
            "points": points,
            "games_played": total,
            "goals_for": gf,
            "goals_against": ga,
            "goal_diff": gf - ga,
            "home_record": f"{home_w}-{home_l}-{home_otl}",
            "away_record": f"{away_w}-{away_l}-{away_otl}",
            "streak": streak,
            "last_5": last5,
            "win_pct": round(wins / total * 100, 1) if total else 0,
            "results": results,
        }

    @staticmethod
    def _compute_playoff_series(games: list[dict]) -> dict | None:
        """Compute the current playoff series status."""
        po_finished = [
            g for g in games
            if g.get("competitiontype") == "PO" and g.get("status") == "FINAL"
        ]
        po_future = [
            g for g in games
            if g.get("competitiontype") == "PO" and g.get("status") == "FUTURE"
        ]

        if not po_finished and not po_future:
            return None

        # Find the most recent opponent to identify current series
        all_po = sorted(po_finished + po_future, key=lambda x: x.get("matchstart", ""))
        if not all_po:
            return None

        # Get the latest series opponent
        latest = all_po[-1]
        if _is_adler_home(latest):
            opp_name = latest.get("awayteam", "?")
        else:
            opp_name = latest.get("hometeam", "?")

        adler_wins = 0
        opp_wins = 0
        series_games = []

        for g in sorted(po_finished, key=lambda x: x.get("matchstart", "")):
            is_home = _is_adler_home(g)
            opp = g.get("awayteam") if is_home else g.get("hometeam")
            if opp != opp_name:
                continue
            a_score, o_score = _adler_score(g)
            if a_score > o_score:
                adler_wins += 1
            else:
                opp_wins += 1
            series_games.append({
                "date": g.get("matchstart", ""),
                "score": f"{a_score}:{o_score}",
                "is_home": is_home,
                "won": a_score > o_score,
            })

        best_of = latest.get("bestOf", 7) or 7

        return {
            "opponent": opp_name,
            "adler_wins": adler_wins,
            "opp_wins": opp_wins,
            "best_of": best_of,
            "games": series_games,
            "is_active": adler_wins < (best_of // 2 + 1) and opp_wins < (best_of // 2 + 1),
        }

    @staticmethod
    def _extract_game_stats(game: dict | None) -> dict | None:
        """Extract team stats from a game detail response."""
        if not game:
            return None

        adler_home = _is_adler_home(game)

        def pick(home_key: str, away_key: str):
            h = game.get(home_key, 0) or 0
            a = game.get(away_key, 0) or 0
            return (h, a) if adler_home else (a, h)

        shots_a, shots_o = pick("home_shotsongoal", "away_shotsongoal")
        fo_a, fo_o = pick("home_faceoffswon", "away_faceoffswon")
        fo_total_a, fo_total_o = pick("home_faceoffs", "away_faceoffs")
        pp_goals_a, pp_goals_o = pick("home_powerplaygoals", "away_powerplaygoals")
        pp_adv_a, pp_adv_o = pick("home_powerplayadvantages", "away_powerplayadvantages")
        pim_a, pim_o = pick("home_penaltyminutes", "away_penaltyminutes")
        saves_a, saves_o = pick("home_saves", "away_saves")

        return {
            "status": game.get("status"),
            "shots_adler": shots_a,
            "shots_opponent": shots_o,
            "faceoff_pct_adler": round(fo_a / fo_total_a * 100, 1) if fo_total_a else 0,
            "faceoff_pct_opponent": round(fo_o / fo_total_o * 100, 1) if fo_total_o else 0,
            "powerplay_adler": f"{pp_goals_a}/{pp_adv_a}" if pp_adv_a else "0/0",
            "powerplay_opponent": f"{pp_goals_o}/{pp_adv_o}" if pp_adv_o else "0/0",
            "pim_adler": pim_a,
            "pim_opponent": pim_o,
            "saves_adler": saves_a,
            "saves_opponent": saves_o,
            "attendance": game.get("attendance"),
            "arena": game.get("arena"),
        }

    # ── Interval calculation ──────────────────────────────

    @staticmethod
    def _calculate_interval(is_live: bool, next_game: dict | None) -> int:
        if is_live:
            return UPDATE_INTERVAL_LIVE
        if next_game:
            matchstart = _parse_matchstart(next_game.get("matchstart"))
            if matchstart:
                seconds_until = (matchstart - datetime.now(timezone.utc)).total_seconds()
                if seconds_until <= 600:
                    return UPDATE_INTERVAL_PRE_GAME
                if seconds_until <= 3600:
                    return UPDATE_INTERVAL_APPROACHING
        return UPDATE_INTERVAL_IDLE

    # ── Event detection ───────────────────────────────────

    def _is_adler_goal(self, goal: dict, game: dict) -> bool:
        adler_home = game.get("homeclubid") == ADLER_CLUB_ID
        adler_logoid = game.get("homelogoid") if adler_home else game.get("awaylogoid")
        if adler_logoid is not None:
            return goal.get("teamlogoid") == adler_logoid
        return adler_home

    def _detect_events(self, current_game: dict | None, summary: dict | None) -> None:
        game_id = current_game.get("id") if current_game else None
        is_live = current_game is not None

        if game_id != self._current_game_id:
            if self._was_live:
                self.hass.bus.async_fire(EVENT_GAME_END)
                _LOGGER.info("Game ended")

            self._current_game_id = game_id
            self._known_goal_ids.clear()
            self._known_penalty_ids.clear()
            self._known_periods = 0

            if current_game:
                for goal in current_game.get("goals", []):
                    if gid := goal.get("id"):
                        self._known_goal_ids.add(gid)
                for pen in current_game.get("penalties", []):
                    if pid := pen.get("id"):
                        self._known_penalty_ids.add(pid)

                if summary:
                    for key in _SUMMARY_KEYS:
                        if key in summary and key not in current_game:
                            current_game[key] = summary[key]

                self.hass.bus.async_fire(EVENT_GAME_START, {
                    "game_id": game_id,
                    "home_team": current_game.get("hometeam"),
                    "away_team": current_game.get("awayteam"),
                    "match_start": _format_local(current_game.get("matchstart")),
                })

            self._was_live = is_live
            return

        self._was_live = is_live
        if not current_game:
            return

        if summary:
            for key in _SUMMARY_KEYS:
                if key in summary and key not in current_game:
                    current_game[key] = summary[key]

        # Detect new goals
        for goal in current_game.get("goals", []):
            goal_id = goal.get("id")
            if not goal_id or goal_id in self._known_goal_ids:
                continue
            self._known_goal_ids.add(goal_id)
            is_adler = self._is_adler_goal(goal, current_game)
            scorer = goal.get("scorer", {})
            self.hass.bus.async_fire(EVENT_GOAL, {
                "goal_id": goal_id,
                "is_adler_goal": is_adler,
                "period": goal.get("period"),
                "time": goal.get("time"),
                "goaltype": goal.get("goaltype"),
                "scorer": format_scorer(scorer),
                "scorer_jersey": scorer.get("jersey") if scorer else None,
                "assist1": format_scorer(goal.get("assist1", {})),
                "assist2": format_scorer(goal.get("assist2", {})),
                "score_home": current_game.get("homescore"),
                "score_away": current_game.get("awayscore"),
                "home_team": current_game.get("hometeam"),
                "away_team": current_game.get("awayteam"),
            })

        # Detect new penalties
        for pen in current_game.get("penalties", []):
            pid = pen.get("id")
            if not pid or pid in self._known_penalty_ids:
                continue
            self._known_penalty_ids.add(pid)
            player = pen.get("player", {})
            self.hass.bus.async_fire(EVENT_PENALTY, {
                "player": format_scorer(player),
                "infraction": pen.get("infraction"),
                "minutes": pen.get("penaltytime"),
                "period": pen.get("period"),
                "time": pen.get("time"),
            })

        # Detect period ends
        for i in (1, 2, 3):
            if current_game.get(f"home_goals_period{i}") is not None and i > self._known_periods:
                self._known_periods = i
                self.hass.bus.async_fire(EVENT_PERIOD_END, {"period": i})
