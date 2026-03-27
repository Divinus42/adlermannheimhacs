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

PLATFORMS = ["sensor", "binary_sensor"]

CARD_DIR = Path(__file__).parent / "www"
CARDS = {
    "scoreboard-card.js": "adler-mannheim-scoreboard.js",
    "season-overview-card.js": "adler-season-overview.js",
}


def _install_cards(hass: HomeAssistant) -> None:
    """Copy all card JS files to /config/www/ so they're available at /local/."""
    www_dir = Path(hass.config.path("www"))
    www_dir.mkdir(exist_ok=True)

    for source_name, target_name in CARDS.items():
        source = CARD_DIR / source_name
        if source.exists():
            shutil.copy2(str(source), str(www_dir / target_name))
            _LOGGER.info("Card installed: /local/%s", target_name)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Adler Mannheim from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    # Install/update the scoreboard card JS file (once per HA start)
    if "card_installed" not in hass.data[DOMAIN]:
        try:
            await hass.async_add_executor_job(_install_cards, hass)
        except Exception:  # noqa: BLE001
            _LOGGER.warning(
                "Could not auto-install cards. "
                "Copy JS files manually to /config/www/"
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
