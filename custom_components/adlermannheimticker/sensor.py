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
from .coordinator import AdlerMannheimCoordinator, format_scorer, photo_url

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
        AdlerMannheimSeasonSensor(coordinator),
        AdlerMannheimPlayoffSensor(coordinator),
        AdlerMannheimGameStatsSensor(coordinator),
        AdlerMannheimClockSensor(coordinator),
        AdlerMannheimStandingsSensor(coordinator),
        AdlerMannheimTopScorerSensor(coordinator),
        AdlerMannheimGoalieSensor(coordinator),
        AdlerMannheimRosterSensor(coordinator),
        AdlerMannheimLineupSensor(coordinator),
        AdlerMannheimCompetitionsSensor(coordinator),
    ])


def _is_adler_home(game: dict) -> bool:
    """Check if Adler Mannheim is the home team."""
    if game.get("homeclubid") == ADLER_CLUB_ID:
        return True
    # Fallback to team name
    return "Adler" in (game.get("hometeam") or "")


def _asset_url(path: str | None) -> str | None:
    """Return a usable logo URL.

    The detail endpoint hands out absolute S3 URLs while older payload shapes
    carry a site-relative path, so only a relative path gets the host prefix.
    """
    if not path:
        return None
    if path.startswith(("http://", "https://", "//")):
        return path
    return f"{_LOGO_BASE}{path}"


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

        attrs = {
            "game_id": game.get("id"),
            "status": status,
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
            "competition_title": game.get("competitionshorttitle"),
            "matchday": game.get("matchday"),
            "arena": game.get("arena"),
            "attendance": game.get("attendance") or None,
            "rank_home": game.get("homerank"),
            "rank_away": game.get("awayrank"),
            "rank_adler": game.get("homerank") if adler_is_home else game.get("awayrank"),
            "rank_opponent": game.get("awayrank") if adler_is_home else game.get("homerank"),
            "home_logo": _asset_url(game.get("homelogourl")) or photo_url(game.get("homelogoid"), 160),
            "away_logo": _asset_url(game.get("awaylogourl")) or photo_url(game.get("awaylogoid"), 160),
            "competition_logo": _asset_url(game.get("competitionlogourl")),
            "league_color": game.get("leaguebackgroundcolor"),
            "link_livestream": game.get("link_Livestream"),
            "link_ticketing": game.get("link_Ticketing"),
            "tickets_soldout": game.get("ticketsSoldout"),
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
                    "score_home": g.get("homescore"),
                    "score_away": g.get("awayscore"),
                    "scorer": format_scorer(g.get("scorer", {})),
                    "scorer_jersey": g.get("scorer", {}).get("jersey"),
                    "scorer_photo": photo_url(g.get("scorer", {}).get("photoid"), 120),
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
                    "player_jersey": p.get("player", {}).get("jersey"),
                    "infraction": p.get("infraction"),
                    "minutes": p.get("penaltytime"),
                    "is_adler": p.get("teamlogoid") == adler_logoid,
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
            attrs["last_scorer_photo"] = photo_url(
                g.get("scorer", {}).get("photoid"), 160
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


class AdlerMannheimSeasonSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the league record (W-L-OTL)."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Saison"
        self._attr_unique_id = "adler_mannheim_season"
        self._attr_icon = "mdi:chart-bar"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_season"

    @property
    def native_value(self) -> str | None:
        if not self.coordinator.data:
            return None
        stats = self.coordinator.data.get("season_stats")
        if not stats:
            return None
        return f"{stats['wins']}W-{stats['losses']}L-{stats['otl']}OTL"

    @property
    def extra_state_attributes(self) -> dict | None:
        if not self.coordinator.data:
            return None
        stats = self.coordinator.data.get("season_stats")
        if not stats:
            return None

        attrs = {
            "wins": stats["wins"],
            "regulation_wins": stats["regulation_wins"],
            "ot_wins": stats["ot_wins"],
            "losses": stats["losses"],
            "otl": stats["otl"],
            "points": stats["points"],
            "games_played": stats["games_played"],
            "goals_for": stats["goals_for"],
            "goals_against": stats["goals_against"],
            "goal_diff": stats["goal_diff"],
            "home_record": stats["home_record"],
            "away_record": stats["away_record"],
            "streak": stats["streak"],
            "last_5": stats["last_5"],
            "win_pct": stats["win_pct"],
        }

        # The club publishes its own table row, which is the authoritative
        # record and the only place a rank comes from.
        standings = self.coordinator.data.get("standings") or {}
        official = standings.get("adler")
        if official:
            attrs["official_rank"] = official.get("rank")
            attrs["official_points"] = official.get("points")
            attrs["official_games_played"] = official.get("games_played")
            attrs["official_home_record"] = official.get("home_record")
            attrs["official_road_record"] = official.get("road_record")

        return attrs


class AdlerMannheimCompetitionsSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the record across every competition, CHL included."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Wettbewerbe"
        self._attr_unique_id = "adler_mannheim_competitions"
        self._attr_icon = "mdi:tournament"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_competitions"

    def _total(self) -> dict | None:
        if not self.coordinator.data:
            return None
        competitions = self.coordinator.data.get("competitions") or {}
        return competitions.get("total")

    @property
    def native_value(self) -> str | None:
        total = self._total()
        if not total:
            return None
        return f"{total['wins']}W-{total['losses']}L-{total['otl']}OTL"

    @property
    def extra_state_attributes(self) -> dict | None:
        if not self.coordinator.data:
            return None
        competitions = self.coordinator.data.get("competitions") or {}
        total = competitions.get("total")
        if not total:
            return None

        by_competition = competitions.get("by_competition") or {}
        summary = {}
        for key, record in by_competition.items():
            summary[key] = {
                "title": record.get("title"),
                "record": f"{record['wins']}-{record['losses']}-{record['otl']}",
                "games_played": record["games_played"],
                "points": record["points"],
                "goals_for": record["goals_for"],
                "goals_against": record["goals_against"],
                "goal_diff": record["goal_diff"],
                "streak": record["streak"],
                "last_5": record["last_5"],
            }

        return {
            "games_played": total["games_played"],
            "wins": total["wins"],
            "losses": total["losses"],
            "otl": total["otl"],
            "goals_for": total["goals_for"],
            "goals_against": total["goals_against"],
            "goal_diff": total["goal_diff"],
            "streak": total["streak"],
            "last_5": total["last_5"],
            "competitions": summary,
            "results": total["results"][-20:],
        }


class AdlerMannheimPlayoffSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the current playoff series status."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Playoff"
        self._attr_unique_id = "adler_mannheim_playoff"
        self._attr_icon = "mdi:trophy"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_playoff"

    @property
    def native_value(self) -> str | None:
        if not self.coordinator.data:
            return None
        series = self.coordinator.data.get("playoff_series")
        if not series:
            return "Keine Playoffs"
        return f"Adler {series['adler_wins']}:{series['opp_wins']} {series['opponent']}"

    @property
    def extra_state_attributes(self) -> dict | None:
        if not self.coordinator.data:
            return None
        series = self.coordinator.data.get("playoff_series")
        if not series:
            return None
        return {
            "opponent": series["opponent"],
            "adler_wins": series["adler_wins"],
            "opponent_wins": series["opp_wins"],
            "best_of": series["best_of"],
            "is_active": series["is_active"],
            "games": series["games"],
        }


class AdlerMannheimGameStatsSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the team comparison of the running or last game."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Spielstatistik"
        self._attr_unique_id = "adler_mannheim_game_stats"
        self._attr_icon = "mdi:chart-line"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_game_stats"

    @property
    def native_value(self) -> str | None:
        if not self.coordinator.data:
            return None
        stats = self.coordinator.data.get("game_stats")
        if not stats:
            return None
        return stats.get("status", "idle")

    @property
    def extra_state_attributes(self) -> dict | None:
        if not self.coordinator.data:
            return None
        return self.coordinator.data.get("game_stats")


class AdlerMannheimClockSensor(CoordinatorEntity, SensorEntity):
    """Sensor carrying the game clock from the club ticker.

    The scoreboard card reads `elapsed_seconds` plus the local timestamp of
    the last update to keep counting between two polls, so the displayed time
    moves even though the API is only read every few seconds.
    """

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Spieluhr"
        self._attr_unique_id = "adler_mannheim_clock"
        self._attr_icon = "mdi:timer-outline"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_clock"

    def _clock(self) -> dict | None:
        if not self.coordinator.data:
            return None
        return self.coordinator.data.get("clock")

    @property
    def native_value(self) -> str | None:
        clock = self._clock()
        if not clock:
            return "idle"
        if clock.get("clock"):
            return clock["clock"]
        period = clock.get("period")
        return f"P{period}" if period else "idle"

    @property
    def extra_state_attributes(self) -> dict | None:
        clock = self._clock()
        if not clock:
            return {"source": None, "running": False}

        # No timestamp of our own here: the card measures how long ago the
        # clock arrived from the state's own last_updated, and an attribute
        # that changed on every poll would both reset that measurement and
        # force a state write on every tick even when nothing moved.
        attrs = dict(clock)

        ticker = self.coordinator.data.get("ticker") or {}
        attrs["ticker_events"] = ticker.get("events", [])[-10:]
        attrs["ticker_types"] = ticker.get("types")
        return attrs


class AdlerMannheimStandingsSensor(CoordinatorEntity, SensorEntity):
    """Sensor carrying the league table the club publishes."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Tabelle"
        self._attr_unique_id = "adler_mannheim_standings"
        self._attr_icon = "mdi:format-list-numbered"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_standings"

    def _standings(self) -> dict | None:
        if not self.coordinator.data:
            return None
        return self.coordinator.data.get("standings")

    @property
    def native_value(self) -> int | str | None:
        standings = self._standings()
        if not standings:
            return None
        return standings.get("adler_rank") or "unbekannt"

    @property
    def extra_state_attributes(self) -> dict | None:
        standings = self._standings()
        if not standings:
            return None

        groups = standings.get("groups") or {}
        primary_key = next(iter(groups), None)
        primary = groups.get(primary_key) if primary_key else None

        attrs = {
            "adler_rank": standings.get("adler_rank"),
            "adler": standings.get("adler"),
            "groups": list(groups.keys()),
        }

        if primary:
            attrs.update({
                "title": primary.get("title"),
                "updated": primary.get("updated"),
                "playoff_cut": primary.get("playoff_cut"),
                "playoff_cut_legend": primary.get("playoff_cut_legend"),
                "qualification_cut": primary.get("qualification_cut"),
                "qualification_cut_legend": primary.get("qualification_cut_legend"),
                "teams": primary.get("teams"),
            })

        return attrs


class AdlerMannheimTopScorerSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the squad's leading scorer."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Topscorer"
        self._attr_unique_id = "adler_mannheim_top_scorer"
        self._attr_icon = "mdi:medal"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_top_scorer"

    def _scorers(self) -> list[dict]:
        if not self.coordinator.data:
            return []
        team = self.coordinator.data.get("team") or {}
        return team.get("top_scorers") or []

    @property
    def native_value(self) -> str | None:
        scorers = self._scorers()
        if not scorers:
            return None
        return scorers[0].get("name")

    @property
    def extra_state_attributes(self) -> dict | None:
        scorers = self._scorers()
        if not scorers:
            return None

        leader = scorers[0]
        team = self.coordinator.data.get("team") or {}
        return {
            "points": leader.get("points"),
            "goals": leader.get("goals"),
            "assists": leader.get("assists"),
            "jersey": leader.get("jersey"),
            "position": leader.get("position"),
            "photo": leader.get("photo"),
            "competition": leader.get("competition"),
            "updated": team.get("updated"),
            "top_scorers": scorers,
        }


class AdlerMannheimGoalieSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the goaltender with the most ice time."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Torhüter"
        self._attr_unique_id = "adler_mannheim_goalie"
        self._attr_icon = "mdi:hand-back-right"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_goalie"

    def _goalies(self) -> list[dict]:
        if not self.coordinator.data:
            return []
        team = self.coordinator.data.get("team") or {}
        return team.get("goalies") or []

    @property
    def native_value(self) -> str | None:
        goalies = self._goalies()
        if not goalies:
            return None
        return goalies[0].get("name")

    @property
    def extra_state_attributes(self) -> dict | None:
        goalies = self._goalies()
        if not goalies:
            return None

        leader = goalies[0]
        return {
            "save_percentage": leader.get("savepercentage"),
            "goals_against_average": leader.get("goalsagainstaverage"),
            "games_played": leader.get("gamesplayed"),
            "minutes": leader.get("minutes"),
            "shutouts": leader.get("shutouts"),
            "jersey": leader.get("jersey"),
            "photo": leader.get("photo"),
            "goalies": goalies,
        }


class AdlerMannheimRosterSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing the squad and who is currently injured."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Kader"
        self._attr_unique_id = "adler_mannheim_roster"
        self._attr_icon = "mdi:account-group"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_roster"

    def _roster(self) -> dict | None:
        if not self.coordinator.data:
            return None
        return self.coordinator.data.get("roster")

    @property
    def native_value(self) -> int | None:
        roster = self._roster()
        if not roster:
            return None
        return roster.get("count")

    @property
    def extra_state_attributes(self) -> dict | None:
        roster = self._roster()
        if not roster:
            return None
        return {
            "injured_count": roster.get("injured_count"),
            "injured": roster.get("injured"),
            "by_position": roster.get("by_position"),
            "team_photo": roster.get("team_photo"),
        }


class AdlerMannheimLineupSensor(CoordinatorEntity, SensorEntity):
    """Sensor showing who was on the Adler game sheet.

    The API delivers the Adler bench only and without per-player counters, so
    this names who played rather than how they played.
    """

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Aufstellung"
        self._attr_unique_id = "adler_mannheim_lineup"
        self._attr_icon = "mdi:clipboard-list-outline"
        self._attr_device_info = _get_device_info()
        self.entity_id = "sensor.adler_mannheim_lineup"

    def _lineup(self) -> dict | None:
        if not self.coordinator.data:
            return None
        return self.coordinator.data.get("lineup")

    @property
    def native_value(self) -> int | None:
        lineup = self._lineup()
        if not lineup:
            return None
        return lineup.get("adler_count")

    @property
    def extra_state_attributes(self) -> dict | None:
        lineup = self._lineup()
        if not lineup:
            return None
        return {
            "adler": lineup.get("adler"),
            "by_position": lineup.get("by_position"),
        }
