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


def _parse_matchstart(matchstart: str | None) -> str | None:
    """Parse matchstart string to formatted date string."""
    if not matchstart:
        return None
    try:
        dt = datetime.strptime(matchstart, "%Y-%m-%d %H:%M:%S %z")
        return dt.strftime("%d.%m. %H:%M")
    except (ValueError, TypeError):
        return matchstart


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
            return _parse_matchstart(game.get("matchstart"))

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
            "match_start": game.get("matchstart"),
            "competition": game.get("competitiontype"),
            "home_logo": f"{_LOGO_BASE}{home_logo_path}" if home_logo_path else None,
            "away_logo": f"{_LOGO_BASE}{away_logo_path}" if away_logo_path else None,
        }

        # Period scores (from detail endpoint)
        for period in (1, 2, 3):
            h = game.get(f"home_goals_period{period}")
            a = game.get(f"away_goals_period{period}")
            if h is not None:
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
        if goals:
            attrs["goals"] = [
                {
                    "period": g.get("period"),
                    "time": g.get("time"),
                    "type": g.get("goaltype"),
                    "scorer": format_scorer(g.get("scorer", {})),
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
