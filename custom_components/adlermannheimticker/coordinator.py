import asyncio
from homeassistant.util import dt as dt_util
from datetime import timedelta
import logging

import aiohttp
from homeassistant.helpers.event import async_track_point_in_time
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

_LOGGER = logging.getLogger(__name__)

BASE_URL = "https://www.adler-mannheim.de/jsonapi/game/"  # Beispiel, anpassen

ADLER_CLUB_ID = 6  # Adler Mannheim Club ID


class AdlerMannheimCoordinator(DataUpdateCoordinator):
    """Coordinator für Adler Mannheim Spiele."""

    def __init__(self, hass):
        super().__init__(
            hass,
            _LOGGER,
            name="Adler Mannheim",
            update_interval=None,  # Wir planen selbst manuell
        )
        self._unsub_timer = None

    async def _async_update_data(self):
        try:
            async with aiohttp.ClientSession() as session:
                # 1. Alle Spiele abrufen
                async with session.get(BASE_URL) as resp:
                    if resp.status != 200:
                        raise UpdateFailed(f"API error: {resp.status}")
                    games = await resp.json()

                # 2. Spiele nach Status filtern
                finished = [g for g in games if g["status"] == "FINAL"]
                running = [g for g in games if g["status"] == "LIVE"]
                future = [g for g in games if g["status"] == "FUTURE"]

                last_game = None
                current_game = None
                next_game = None

                if finished:
                    last_game = sorted(
                        finished, key=lambda x: x["matchstart"], reverse=True
                    )[0]

                if running:
                    current_game = running[0]

                if future:
                    next_game = sorted(future, key=lambda x: x["matchstart"])[0]

                # 3. Details für die drei Spiele abrufen
                async def fetch_detail(game):
                    if not game:
                        return None
                    game_id = game.get("id")
                    if not game_id:
                        return game
                    async with session.get(f"{BASE_URL}{game_id}") as resp:
                        if resp.status == 200:
                            return await resp.json()
                        return game  # fallback, falls Detail nicht verfügbar

                last_game, current_game, next_game = await asyncio.gather(
                    fetch_detail(last_game),
                    fetch_detail(current_game),
                    fetch_detail(next_game),
                )

                # 🔁 Update-Planung anpassen
                self._schedule_next_refresh(current_game is not None)

                return {
                    "last_game": last_game,
                    "current_game": current_game,
                    "next_game": next_game,
                    "all_games": games,
                }

        except Exception as err:
            raise UpdateFailed(f"Error fetching Adler Mannheim data: {err}")

    def _schedule_next_refresh(self, running: bool):
        """Plane das nächste Update zur vollen Minute oder halben Stunde (UTC-basiert)."""
        # Alten Timer entfernen, falls vorhanden
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None

        now = dt_util.utcnow()
        if running:
            next_time = (now + timedelta(minutes=1)).replace(second=0, microsecond=0)
            interval_desc = "jede volle Minute"
        else:
            minute = 0 if now.minute < 30 else 30
            next_time = now.replace(minute=minute, second=0, microsecond=0)
            if next_time <= now:
                next_time += timedelta(minutes=30)
            interval_desc = "volle/halbe Stunde"

        local_next = dt_util.as_local(next_time)
        _LOGGER.debug(
            f"Plane nächstes Update ({interval_desc}) "
            f"→ UTC: {next_time.isoformat()} / Lokal: {local_next.isoformat()}"
        )

        # 👇 Asynchrones Callback definieren und registrieren
        async def _handle_refresh(_):
            await self.async_request_refresh()

        self._unsub_timer = async_track_point_in_time(
            self.hass, _handle_refresh, next_time
        )
