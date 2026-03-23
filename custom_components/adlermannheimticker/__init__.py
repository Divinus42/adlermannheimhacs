"""Adler Mannheim integration for Home Assistant."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .coordinator import AdlerMannheimCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]
CARD_DIR = Path(__file__).parent / "www"


async def _register_card(hass: HomeAssistant) -> None:
    """Register the scoreboard card static files. Best-effort, never blocks setup."""
    url = f"/{DOMAIN}/www"
    path = str(CARD_DIR)

    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(url, path, False)]
        )
        _LOGGER.debug("Scoreboard card registered at %s", url)
    except Exception:  # noqa: BLE001
        _LOGGER.warning(
            "Could not auto-register scoreboard card. "
            "Add it manually as a Lovelace resource: %s/scoreboard-card.js",
            url,
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Adler Mannheim from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    # Register static path for the frontend scoreboard card (once)
    if "frontend_registered" not in hass.data[DOMAIN]:
        await _register_card(hass)
        hass.data[DOMAIN]["frontend_registered"] = True

    coordinator = AdlerMannheimCoordinator(hass)
    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload Adler Mannheim config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unload_ok
