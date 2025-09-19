import asyncio
from datetime import timedelta
import logging

import aiohttp

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
            update_interval=timedelta(
                minutes=30
            ),  # Update manuell triggern oder später anpassen
        )

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
                running = [g for g in games if g["status"] == "RUNNING"]
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

                if current_game:
                    self.update_interval = timedelta(minutes=1)
                else:
                    self.update_interval = timedelta(minutes=30)

                return {
                    "last_game": last_game,
                    "current_game": current_game,
                    "next_game": next_game,
                    "all_games": games,
                }

        except Exception as err:
            raise UpdateFailed(f"Error fetching Adler Mannheim data: {err}")
