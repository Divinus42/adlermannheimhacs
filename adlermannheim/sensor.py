from datetime import datetime
import logging

from homeassistant.components.sensor import SensorEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity

_LOGGER = logging.getLogger(__name__)

ADLER_CLUB_ID = 6  # Adler Mannheim Club ID, anpassen falls nötig

# Liste der Sensoren, die wir erstellen wollen
SENSOR_TYPES = [
    "last_game",
    "current_game",
    "next_game",
]


async def async_setup_entry(hass, entry, async_add_entities):
    """Set up the Adler Mannheim sensors."""
    coordinator = hass.data["adlermannheim"][entry.entry_id]

    sensors = []
    for sensor_type in SENSOR_TYPES:
        sensors.append(AdlerMannheimSensor(coordinator, sensor_type))

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
        # Status als Hauptzustand
        return game.get("status")

    @property
    def extra_state_attributes(self):
        """Return the state attributes."""
        game = self.coordinator.data.get(self._sensor_type)
        if not game:
            return None

        home_team = game.get("hometeam", {})
        away_team = game.get("awayteam", {})

        # Gegner ermitteln
        if game.get("homeclubid") == ADLER_CLUB_ID:
            opponent = game.get("awayteam")
            is_home = True
        else:
            opponent = game.get("hometeam")
            is_home = False

        # Zeit umwandeln
        match_time = None
        if game.get("matchstart"):
            try:
                match_time = datetime.fromisoformat(game["matchstart"])
            except Exception:
                match_time = game["matchstart"]

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
            "goals": game.get("goals", []),
            "penalties": game.get("penalties", []),
        }
