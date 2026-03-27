"""Binary sensor entities for the Adler Mannheim integration."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import ADLER_CLUB_ID, DOMAIN
from .coordinator import AdlerMannheimCoordinator, _parse_matchstart


def _get_device_info() -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "adler_mannheim")},
        name="Adler Mannheim",
        manufacturer="Adler Mannheim",
        model="Liveticker",
    )


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up binary sensors."""
    coordinator: AdlerMannheimCoordinator = hass.data[DOMAIN][entry.entry_id]

    async_add_entities([
        AdlerGameLiveSensor(coordinator),
        AdlerGameDaySensor(coordinator),
        AdlerWinningSensor(coordinator),
    ])


class AdlerGameLiveSensor(CoordinatorEntity, BinarySensorEntity):
    """Binary sensor that is ON when a game is currently live."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Spiel Live"
        self._attr_unique_id = "adler_mannheim_game_live"
        self._attr_icon = "mdi:hockey-sticks"
        self._attr_device_info = _get_device_info()
        self.entity_id = "binary_sensor.adler_mannheim_game_live"

    @property
    def is_on(self) -> bool:
        if not self.coordinator.data:
            return False
        return self.coordinator.data.get("is_live", False)


class AdlerGameDaySensor(CoordinatorEntity, BinarySensorEntity):
    """Binary sensor that is ON when there is a game today."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Spieltag"
        self._attr_unique_id = "adler_mannheim_game_day"
        self._attr_icon = "mdi:calendar-today"
        self._attr_device_info = _get_device_info()
        self.entity_id = "binary_sensor.adler_mannheim_game_day"

    @property
    def is_on(self) -> bool:
        if not self.coordinator.data:
            return False
        # Live game = game day
        if self.coordinator.data.get("is_live"):
            return True
        # Check next game date
        next_game = self.coordinator.data.get("next_game")
        if next_game:
            ms = _parse_matchstart(next_game.get("matchstart"))
            if ms:
                from homeassistant.util import dt as dt_util
                today = dt_util.now().date()
                return dt_util.as_local(ms).date() == today
        return False

    @property
    def extra_state_attributes(self) -> dict | None:
        if not self.coordinator.data:
            return None
        next_game = self.coordinator.data.get("next_game")
        if not next_game:
            return None
        adler_home = next_game.get("homeclubid") == ADLER_CLUB_ID or "Adler" in (next_game.get("hometeam") or "")
        return {
            "opponent": next_game.get("awayteam") if adler_home else next_game.get("hometeam"),
            "match_start": next_game.get("matchstart"),
            "is_home": adler_home,
        }


class AdlerWinningSensor(CoordinatorEntity, BinarySensorEntity):
    """Binary sensor that is ON when Adler is currently winning."""

    def __init__(self, coordinator: AdlerMannheimCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_name = "Adler Mannheim Führt"
        self._attr_unique_id = "adler_mannheim_winning"
        self._attr_icon = "mdi:trophy"
        self._attr_device_info = _get_device_info()
        self.entity_id = "binary_sensor.adler_mannheim_winning"

    @property
    def is_on(self) -> bool:
        if not self.coordinator.data:
            return False
        game = self.coordinator.data.get("current_game")
        if not game:
            return False
        adler_home = game.get("homeclubid") == ADLER_CLUB_ID or "Adler" in (game.get("hometeam") or "")
        h = game.get("homescore", 0) or 0
        a = game.get("awayscore", 0) or 0
        adler_score = h if adler_home else a
        opp_score = a if adler_home else h
        return adler_score > opp_score
