"""Adler Mannheim integration for Home Assistant."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .coordinator import AdlerMannheimCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]

CARD_SOURCE = Path(__file__).parent / "www" / "scoreboard-card.js"
CARD_FILENAME = "adler-mannheim-scoreboard.js"


def _install_card(hass: HomeAssistant) -> None:
    """Copy the scoreboard card JS to /config/www/ so it's available at /local/."""
    www_dir = Path(hass.config.path("www"))
    www_dir.mkdir(exist_ok=True)

    target = www_dir / CARD_FILENAME

    # Always overwrite to ensure the latest version is deployed
    shutil.copy2(str(CARD_SOURCE), str(target))
    _LOGGER.info(
        "Scoreboard card installed: /local/%s",
        CARD_FILENAME,
    )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Adler Mannheim from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    # Install/update the scoreboard card JS file (once per HA start)
    if "card_installed" not in hass.data[DOMAIN]:
        try:
            await hass.async_add_executor_job(_install_card, hass)
        except Exception:  # noqa: BLE001
            _LOGGER.warning(
                "Could not auto-install scoreboard card. "
                "Copy scoreboard-card.js manually to /config/www/"
            )
        hass.data[DOMAIN]["card_installed"] = True

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
