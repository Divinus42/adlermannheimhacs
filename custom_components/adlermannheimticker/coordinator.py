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

# Keys to carry from the list endpoint into detail data
_SUMMARY_KEYS = (
    "homeclubid",
    "awayclubid",
    "homelogoid",
    "awaylogoid",
    "homelogourl",
    "awaylogourl",
    "hometeam_short",
    "awayteam_short",
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


class AdlerMannheimCoordinator(DataUpdateCoordinator):
    """Coordinator that fetches Adler Mannheim game data."""

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL_IDLE),
        )
        self._current_game_id: int | None = None
        self._known_goal_ids: set[int] = set()
        self._was_live: bool = False

    async def _async_update_data(self) -> dict:
        """Fetch game data from the Adler Mannheim API."""
        session = async_get_clientsession(self.hass)

        try:
            kwargs = {"timeout": _TIMEOUT} if _TIMEOUT else {}
            async with session.get(BASE_URL, **kwargs) as resp:
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
            key=lambda x: x.get("matchstart", ""),
            reverse=True,
        )
        running = [g for g in games if g.get("status") == "LIVE"]
        future = sorted(
            (g for g in games if g.get("status") == "FUTURE"),
            key=lambda x: x.get("matchstart", ""),
        )

        last_summary = finished[0] if finished else None
        current_summary = running[0] if running else None
        next_summary = future[0] if future else None

        # Fetch detail data for each game
        async def fetch_detail(summary: dict | None) -> dict | None:
            if not summary:
                return None
            gid = summary.get("id")
            if not gid:
                return summary
            try:
                kw = {"timeout": _TIMEOUT} if _TIMEOUT else {}
                async with session.get(f"{BASE_URL}{gid}", **kw) as resp:
                    if resp.status == 200:
                        detail = await resp.json()
                        # Carry over IDs from list endpoint that detail may lack
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

        # Adjust polling interval based on game proximity
        is_live = current_game is not None
        new_interval = self._calculate_interval(is_live, next_game or next_summary)
        if self.update_interval != timedelta(seconds=new_interval):
            self.update_interval = timedelta(seconds=new_interval)
            _LOGGER.debug("Update interval changed to %ss", new_interval)

        # Detect game transitions and new goals
        self._detect_events(current_game, current_summary)

        return {
            "last_game": last_game,
            "current_game": current_game,
            "next_game": next_game,
            "is_live": is_live,
        }

    @staticmethod
    def _calculate_interval(is_live: bool, next_game: dict | None) -> int:
        """Calculate the optimal polling interval based on game proximity."""
        if is_live:
            return UPDATE_INTERVAL_LIVE

        if next_game:
            matchstart = _parse_matchstart(next_game.get("matchstart"))
            if matchstart:
                seconds_until = (
                    matchstart - datetime.now(timezone.utc)
                ).total_seconds()
                if seconds_until <= 600:  # 10 minutes
                    return UPDATE_INTERVAL_PRE_GAME
                if seconds_until <= 3600:  # 1 hour
                    return UPDATE_INTERVAL_APPROACHING

        return UPDATE_INTERVAL_IDLE

    def _is_adler_goal(self, goal: dict, game: dict) -> bool:
        """Determine if a goal was scored by Adler Mannheim."""
        adler_is_home = game.get("homeclubid") == ADLER_CLUB_ID
        adler_logoid = (
            game.get("homelogoid") if adler_is_home else game.get("awaylogoid")
        )
        if adler_logoid is not None:
            return goal.get("teamlogoid") == adler_logoid
        # Fallback: if no logo IDs available, assume home team
        return adler_is_home

    def _detect_events(
        self, current_game: dict | None, summary: dict | None
    ) -> None:
        """Detect game start/end and new goals, fire HA events."""
        game_id = current_game.get("id") if current_game else None
        is_live = current_game is not None

        # Game transition: different game or game ended/started
        if game_id != self._current_game_id:
            # Previous game was live -> fire game_end
            if self._was_live:
                self.hass.bus.async_fire(EVENT_GAME_END)
                _LOGGER.info("Game ended")

            self._current_game_id = game_id
            self._known_goal_ids.clear()

            if current_game:
                # Seed known goals so we don't fire events for existing goals
                for goal in current_game.get("goals", []):
                    if gid := goal.get("id"):
                        self._known_goal_ids.add(gid)

                # Ensure summary IDs are available
                if summary:
                    for key in _SUMMARY_KEYS:
                        if key in summary and key not in current_game:
                            current_game[key] = summary[key]

                self.hass.bus.async_fire(
                    EVENT_GAME_START,
                    {
                        "game_id": game_id,
                        "home_team": current_game.get("hometeam"),
                        "away_team": current_game.get("awayteam"),
                        "match_start": _format_local(
                            current_game.get("matchstart")
                        ),
                    },
                )
                _LOGGER.info(
                    "Game started: %s vs %s",
                    current_game.get("hometeam"),
                    current_game.get("awayteam"),
                )

            self._was_live = is_live
            return

        self._was_live = is_live

        if not current_game:
            return

        # Ensure summary IDs for goal attribution
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
            assist1 = goal.get("assist1", {})
            assist2 = goal.get("assist2", {})

            event_data = {
                "goal_id": goal_id,
                "is_adler_goal": is_adler,
                "period": goal.get("period"),
                "time": goal.get("time"),
                "goaltype": goal.get("goaltype"),
                "scorer": format_scorer(scorer),
                "scorer_jersey": scorer.get("jersey") if scorer else None,
                "assist1": format_scorer(assist1),
                "assist2": format_scorer(assist2),
                "score_home": current_game.get("homescore"),
                "score_away": current_game.get("awayscore"),
                "home_team": current_game.get("hometeam"),
                "away_team": current_game.get("awayteam"),
            }

            self.hass.bus.async_fire(EVENT_GOAL, event_data)
            _LOGGER.info(
                "%s: %s (%s) @ %s",
                "ADLER TOR" if is_adler else "Gegentor",
                format_scorer(scorer),
                goal.get("goaltype"),
                goal.get("time"),
            )
