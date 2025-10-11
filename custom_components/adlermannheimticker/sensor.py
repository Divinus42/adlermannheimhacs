from datetime import datetime
import logging

from homeassistant.components.sensor import SensorEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity

_LOGGER = logging.getLogger(__name__)

ADLER_CLUB_ID = 6  # Adler Mannheim Club ID

# Liste der Sensoren, die wir erstellen wollen
SENSOR_TYPES = [
    "last_game",
    "current_game",
    "next_game",
]

GOAL_SENSOR_TYPES = [
    "current_goals_home",
    "current_goals_away",
    "current_goals_total",
]

# --- Neue Sensoren für Adler-Tor-Alert ---
ALERT_SENSOR_TYPES = [
    "adler_goal_alert",  # Meldung bei neuem Adler-Tor
]


async def async_setup_entry(hass, entry, async_add_entities):
    """Set up the Adler Mannheim sensors."""
    coordinator = hass.data["adlermannheim"][entry.entry_id]

    sensors = []

    # Normale Spiel-Sensoren
    for sensor_type in SENSOR_TYPES:
        sensors.append(AdlerMannheimSensor(coordinator, sensor_type))

    # Goal-Sensoren nur für laufendes Spiel
    for sensor_type in GOAL_SENSOR_TYPES:
        sensors.append(AdlerMannheimGoalSensor(coordinator, sensor_type))

    # Neue Alert-Sensoren
    for sensor_type in ALERT_SENSOR_TYPES:
        sensors.append(AdlerMannheimGoalAlertSensor(coordinator, sensor_type))

    async_add_entities(sensors, True)


class AdlerMannheimSensor(CoordinatorEntity, SensorEntity):
    """Representation of an Adler Mannheim game sensor."""

    def __init__(self, coordinator, sensor_type):
        super().__init__(coordinator)
        self._sensor_type = sensor_type
        self._attr_name = f"Adler Mannheim {sensor_type.replace('_', ' ').title()}"
        self._attr_unique_id = f"adler_mannheim_{sensor_type}"

    @property
    def state(self):
        """Return the state of the sensor."""
        game = self.coordinator.data.get(self._sensor_type)
        if not game:
            return None
        return game.get("status")

    @property
    def extra_state_attributes(self):
        """Return the state attributes."""
        game = self.coordinator.data.get(self._sensor_type)
        if not game:
            return None

        home_team = game.get("hometeam", {})
        away_team = game.get("awayteam", {})

        if game.get("homeclubid") == ADLER_CLUB_ID:
            opponent = game.get("awayteam")
            is_home = True
        else:
            opponent = game.get("hometeam")
            is_home = False

        match_time = None
        if game.get("matchstart"):
            try:
                match_time = datetime.fromisoformat(game["matchstart"])
            except Exception:
                match_time = game.get("matchstart")

        return {
            "game_id": game.get("id"),
            "home_team": home_team,
            "away_team": away_team,
            "opponent": opponent,
            "is_home": is_home,
            "score_home": game.get("homescore"),
            "score_away": game.get("awayscore"),
            "match_start": match_time,
            "status": game.get("status"),
        }


class AdlerMannheimGoalSensor(CoordinatorEntity, SensorEntity):
    """Sensor für Tore im aktuellen Spiel."""

    def __init__(self, coordinator, sensor_type):
        super().__init__(coordinator)
        self._sensor_type = sensor_type
        self._attr_name = f"Adler Mannheim {sensor_type.replace('_', ' ').title()}"
        self._attr_unique_id = f"adler_mannheim_{sensor_type}"

    @property
    def state(self):
        """Return the number of goals."""
        game = self.coordinator.data.get("current_game")
        if not game:
            return None

        home_goals = game.get("homescore", 0) or 0
        away_goals = game.get("awayscore", 0) or 0

        if self._sensor_type == "current_goals_home":
            return home_goals
        elif self._sensor_type == "current_goals_away":
            return away_goals
        elif self._sensor_type == "current_goals_total":
            return home_goals + away_goals
        return None

    @property
    def extra_state_attributes(self):
        """Zusatzinfos: Tore + Flag, ob Adler-Tor."""
        game = self.coordinator.data.get("current_game")
        if not game:
            return None

        goals = []
        adler_is_home = game.get("homeclubid") == ADLER_CLUB_ID

        for goal in game.get("goals", []):
            scoring_team_id = goal.get("clubid")
            is_adler_goal = (
                adler_is_home and scoring_team_id == game.get("homeclubid")
            ) or (not adler_is_home and scoring_team_id == game.get("awayclubid"))

            goals.append(
                {
                    "time": goal.get("time"),
                    "scorer": goal.get("scorer"),
                    "assists": goal.get("assists", []),
                    "team": "Adler Mannheim" if is_adler_goal else "Opponent",
                    "is_adler_goal": is_adler_goal,
                }
            )

        return {
            "adler_is_home": adler_is_home,
            "goals": goals,
        }


# ----- NEU: Sensor für direkte Tor-Alerts -----
class AdlerMannheimGoalAlertSensor(CoordinatorEntity, SensorEntity):
    """Sensor für sofortige Meldung bei neuem Adler-Tor."""

    def __init__(self, coordinator, sensor_type):
        super().__init__(coordinator)
        self._sensor_type = sensor_type
        self._attr_name = f"Adler Mannheim {sensor_type.replace('_', ' ').title()}"
        self._attr_unique_id = f"adler_mannheim_{sensor_type}"
        self._last_total_goals = 0  # für Tor-Detection

    @property
    def state(self):
        game = self.coordinator.data.get("current_game")
        if not game:
            return None

        adler_is_home = game.get("homeclubid") == ADLER_CLUB_ID
        goals_home = game.get("homescore", 0) if adler_is_home else 0
        goals_away = game.get("awayscore", 0) if not adler_is_home else 0
        total_adler_goals = goals_home + goals_away

        if total_adler_goals > self._last_total_goals:
            self._last_total_goals = total_adler_goals
            return f"Neues Adler-Tor! Gesamt: {total_adler_goals}"

        return None

    @property
    def extra_state_attributes(self):
        game = self.coordinator.data.get("current_game")
        if not game:
            return None
        return {
            "game_id": game.get("id"),
            "home_team": game.get("hometeam"),
            "away_team": game.get("awayteam"),
            "status": game.get("status"),
        }
