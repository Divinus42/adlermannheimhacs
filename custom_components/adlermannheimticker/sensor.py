"""Sensor entities for the Adler Mannheim integration."""

from __future__ import annotations

import logging
from datetime import datetime

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .const import ADLER_CLUB_ID, BASE_URL, DOMAIN
from .coordinator import AdlerMannheimCoordinator, format_scorer

_LOGO_BASE = BASE_URL.rsplit("/jsonapi", 1)[0]  # https://www.adler-mannheim.de

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Adler Mannheim sensors."""
    coordinator: AdlerMannheimCoordinator = hass.data[DOMAIN][entry.entry_id]

    async_add_entities([
        AdlerMannheimGameSensor(coordinator, "last_game", "Letztes Spiel"),
        AdlerMannheimGameSensor(coordinator, "current_game", "Aktuelles Spiel"),
        AdlerMannheimGameSensor(coordinator, "next_game", "Nächstes Spiel"),
        AdlerMannheimGoalsSensor(coordinator, "adler_goals", "Adler Tore", is_adler=True),
        AdlerMannheimGoalsSensor(coordinator, "opponent_goals", "Gegner Tore", is_adler=False),
        AdlerMannheimGoalAlertSensor(coordinator),
    ])


def _is_adler_home(game: dict) -> bool:
    """Check if Adler Mannheim is the home team."""
    if game.get("homeclubid") == ADLER_CLUB_ID:
        return True
    # Fallback to team name
    return "Adler" in (game.get("hometeam") or "")


def _get_device_info() -> DeviceInfo:
    """Return shared device info for all sensors."""
    return DeviceInfo(
        identifiers={(DOMAIN, "adler_mannheim")},
        name="Adler Mannheim",
        manufacturer="Adler Mannheim",
        model="Liveticker",
    )


def _parse_matchstart(matchstart: str | None) -> datetime | None:
    """Parse a matchstart UTC string into a timezone-aware datetime."""
    if not matchstart:
        return None
    try:
        return datetime.strptime(matchstart, "%Y-%m-%d %H:%M:%S %z")
    except (ValueError, TypeError):
        return None


def _format_matchstart_local(matchstart: str | None) -> str | None:
    """Parse matchstart and format in the user's local timezone."""
    dt = _parse_matchstart(matchstart)
    if not dt:
        return matchstart
    local_dt = dt_util.as_local(dt)
    return local_dt.strftime("%d.%m. %H:%M")


def _matchstart_iso(matchstart: str | None) -> str | None:
    """Return matchstart as ISO string in local timezone (for JS countdown)."""
    dt = _parse_matchstart(matchstart)
    if not dt:
        return None
    return dt_util.as_local(dt).isoformat()


class AdlerMannheimGameSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing game information (last, current, or next game)."""

    def __init__(
        self,
        coordinator: AdlerMannheimCoordinator,
        key: str,
        name: str,
    ) -> None:
        super().__init__(coordinator)
        self._key = key
        self._attr_name = f"Adler Mannheim {name}"
        self._attr_unique_id = f"adler_mannheim_{key}"
        self._attr_icon = "mdi:hockey-puck"
        self._attr_device_info = _get_device_info()
        self.entity_id = f"sensor.adler_mannheim_{key}"

    @property
    def native_value(self) -> str | None:
        """Return a descriptive game state."""
        if not self.coordinator.data:
            return None
        game = self.coordinator.data.get(self._key)
        if not game:
            return None

        status = game.get("status", "")
        home_score = game.get("homescore", 0)
        away_score = game.get("awayscore", 0)

        if status == "LIVE":
            return f"LIVE {home_score}:{away_score}"
        if status == "FINAL":
            return f"{home_score}:{away_score}"
        if status == "FUTURE":
            return _format_matchstart_local(game.get("matchstart"))

        return status

    @property
    def extra_state_attributes(self) -> dict | None:
        """Return detailed game attributes."""
        if not self.coordinator.data:
            return None
        game = self.coordinator.data.get(self._key)
        if not game:
            return None

        adler_is_home = _is_adler_home(game)
        opponent = game.get("awayteam") if adler_is_home else game.get("hometeam")
        status = game.get("status", "")

        # Build full logo URLs
        home_logo_path = game.get("homelogourl")
        away_logo_path = game.get("awaylogourl")

        attrs = {
            "game_id": game.get("id"),
            "status": game.get("status"),
            "home_team": game.get("hometeam"),
            "away_team": game.get("awayteam"),
            "home_team_short": game.get("hometeam_short"),
            "away_team_short": game.get("awayteam_short"),
            "opponent": opponent,
            "is_home": adler_is_home,
            "score_home": game.get("homescore"),
            "score_away": game.get("awayscore"),
            "match_start": _format_matchstart_local(game.get("matchstart")),
            "match_start_iso": _matchstart_iso(game.get("matchstart")),
            "competition": game.get("competitiontype"),
            "home_logo": f"{_LOGO_BASE}{home_logo_path}" if home_logo_path else None,
            "away_logo": f"{_LOGO_BASE}{away_logo_path}" if away_logo_path else None,
        }

        # Period scores (from detail endpoint, skip for future games)
        if status != "FUTURE":
            for period in (1, 2, 3):
                h = game.get(f"home_goals_period{period}")
                a = game.get(f"away_goals_period{period}")
                if h is not None and (h > 0 or a > 0 or status == "LIVE"):
                    attrs[f"period_{period}"] = f"{h}:{a}"

        ot_h = game.get("home_goals_overtime")
        ot_a = game.get("away_goals_overtime")
        if ot_h is not None and ot_a is not None and (ot_h > 0 or ot_a > 0):
            attrs["overtime"] = f"{ot_h}:{ot_a}"

        so_h = game.get("home_goals_shootout")
        so_a = game.get("away_goals_shootout")
        if so_h is not None and so_a is not None and (so_h > 0 or so_a > 0):
            attrs["shootout"] = f"{so_h}:{so_a}"

        # Goals list (from detail endpoint)
        goals = game.get("goals", [])
        adler_logoid = (
            game.get("homelogoid") if adler_is_home else game.get("awaylogoid")
        )
        if goals:
            attrs["goals"] = [
                {
                    "period": g.get("period"),
                    "time": g.get("time"),
                    "type": g.get("goaltype"),
                    "is_adler_goal": (
                        g.get("teamlogoid") == adler_logoid
                        if adler_logoid is not None
                        else False
                    ),
                    "scorer": format_scorer(g.get("scorer", {})),
                    "scorer_jersey": g.get("scorer", {}).get("jersey"),
                    "scorer_photo": (
                        f"{_LOGO_BASE}{g['scorer']['photourl']}"
                        if g.get("scorer", {}).get("photourl")
                        else None
                    ),
                    "assist1": format_scorer(g.get("assist1", {})),
                    "assist2": format_scorer(g.get("assist2", {})),
                }
                for g in goals
            ]

        # Penalties (from detail endpoint)
        penalties = game.get("penalties", [])
        if penalties:
            attrs["penalties"] = [
                {
                    "period": p.get("period"),
                    "time": p.get("time"),
                    "player": format_scorer(p.get("player", {})),
                    "infraction": p.get("infraction"),
                    "minutes": p.get("penaltytime"),
                }
                for p in penalties
            ]

        return attrs


class AdlerMannheimGoalsSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing goal count for Adler or opponent in the current game."""

    def __init__(
        self,
        coordinator: AdlerMannheimCoordinator,
        key: str,
        name: str,
        *,
        is_adler: bool,
    ) -> None:
        super().__init__(coordinator)
        self._is_adler = is_adler
        self._attr_name = f"Adler Mannheim {name}"
        self._attr_unique_id = f"adler_mannheim_{key}"
        self._attr_icon = "mdi:hockey-puck"
        self._attr_device_info = _get_device_info()
        self.entity_id = f"sensor.adler_mannheim_{key}"

    @property
    def native_value(self) -> int:
        """Return the goal count."""
        if not self.coordinator.data:
            return 0
        game = self.coordinator.data.get("current_game")
        if not game:
            return 0

        adler_is_home = _is_adler_home(game)
        home_score = game.get("homescore", 0) or 0
        away_score = game.get("awayscore", 0) or 0

        if self._is_adler:
            return home_score if adler_is_home else away_score
        return away_score if adler_is_home else home_score

    @property
    def extra_state_attributes(self) -> dict | None:
        """Return goal details for Adler or opponent goals."""
        if not self.coordinator.data:
            return None
        game = self.coordinator.data.get("current_game")
        if not game:
            return None

        adler_is_home = _is_adler_home(game)
        adler_logoid = (
            game.get("homelogoid") if adler_is_home else game.get("awaylogoid")
        )

        goals = []
        for g in game.get("goals", []):
            is_adler_goal = (
                g.get("teamlogoid") == adler_logoid if adler_logoid else False
            )
            if is_adler_goal == self._is_adler:
                goals.append({
                    "period": g.get("period"),
                    "time": g.get("time"),
                    "type": g.get("goaltype"),
                    "scorer": format_scorer(g.get("scorer", {})),
                    "assist1": format_scorer(g.get("assist1", {})),
                    "assist2": format_scorer(g.get("assist2", {})),
                })

        return {
            "goals": goals,
            "opponent": game.get("awayteam") if adler_is_home else game.get("hometeam"),
            "game_status": game.get("status"),
        }


class AdlerMannheimGoalAlertSensor(CoordinatorEntity, SensorEntity):
    """Sensor that changes state on every new Adler Mannheim goal.

    Use this sensor as automation trigger:
      trigger:
        - platform: state
          entity_id: sensor.adler_mannheim_tor_alert
    """

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Tor Alert"
        self._attr_unique_id = "adler_mannheim_goal_alert"
        self._attr_icon = "mdi:hockey-puck"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_goal_alert"
        # Track which Adler goals we have already seen
        self._known_adler_goal_ids: set[int] = set()
        self._goal_count: int = 0
        self._last_goal: dict | None = None
        self._initialized: bool = False

    def _handle_coordinator_update(self) -> None:
        """Process coordinator data and detect new Adler goals."""
        game = (
            self.coordinator.data.get("current_game")
            if self.coordinator.data
            else None
        )

        if not game or game.get("status") != "LIVE":
            if self._initialized:
                # Game ended or disappeared — full reset for next game
                self._known_adler_goal_ids.clear()
                self._goal_count = 0
                self._last_goal = None
                self._initialized = False
            self.async_write_ha_state()
            return

        adler_is_home = _is_adler_home(game)
        adler_logoid = (
            game.get("homelogoid") if adler_is_home else game.get("awaylogoid")
        )

        for g in game.get("goals", []):
            gid = g.get("id")
            if not gid or gid in self._known_adler_goal_ids:
                continue

            # Check if this is an Adler goal
            is_adler = (
                g.get("teamlogoid") == adler_logoid if adler_logoid else False
            )
            if not is_adler:
                continue

            self._known_adler_goal_ids.add(gid)

            if self._initialized:
                # Real new goal detected during game — increment counter
                self._goal_count += 1
                self._last_goal = g

        if not self._initialized:
            # First update: seed with current Adler score, don't trigger
            self._goal_count = (
                (game.get("homescore", 0) or 0)
                if adler_is_home
                else (game.get("awayscore", 0) or 0)
            )
            self._initialized = True

        self.async_write_ha_state()

    @property
    def native_value(self) -> int:
        """Return the Adler goal count. Changes on every new goal."""
        return self._goal_count

    @property
    def extra_state_attributes(self) -> dict | None:
        """Return details of the last detected Adler goal."""
        attrs: dict = {"goals_detected": self._goal_count}

        if self._last_goal:
            g = self._last_goal
            attrs["last_scorer"] = format_scorer(g.get("scorer", {}))
            attrs["last_scorer_jersey"] = (
                g.get("scorer", {}).get("jersey") if g.get("scorer") else None
            )
            attrs["last_time"] = g.get("time")
            attrs["last_period"] = g.get("period")
            attrs["last_type"] = g.get("goaltype")
            attrs["last_assist1"] = format_scorer(g.get("assist1", {}))
            attrs["last_assist2"] = format_scorer(g.get("assist2", {}))

        if self.coordinator.data:
            game = self.coordinator.data.get("current_game")
            if game:
                attrs["game_status"] = game.get("status")
                attrs["score_home"] = game.get("homescore")
                attrs["score_away"] = game.get("awayscore")
                attrs["home_team"] = game.get("hometeam")
                attrs["away_team"] = game.get("awayteam")

        return attrs
