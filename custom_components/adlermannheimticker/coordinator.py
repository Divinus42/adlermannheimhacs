"""Data coordinator for the Adler Mannheim integration."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    ADLER_CLUB_ID,
    API_BASE,
    API_TIMEOUT,
    BASE_URL,
    COMPETITION_LEAGUE,
    COMPETITION_PLAYOFF,
    COMPETITION_TITLES,
    COMPETITIONS_EXHIBITION,
    DOMAIN,
    EVENT_GAME_END,
    EVENT_GAME_START,
    EVENT_GOAL,
    EVENT_PENALTY,
    EVENT_PERIOD_END,
    GAME_URL,
    PLAYER_URL,
    SITE_URL,
    STANDINGS_URL,
    TEAM_URL,
    THROTTLE_DETAIL_SIDE_LIVE,
    THROTTLE_GAMES_LIVE,
    THROTTLE_ROSTER,
    THROTTLE_STANDINGS,
    THROTTLE_TEAM,
    THROTTLE_TICKER_IDLE,
    THROTTLE_TICKER_LIVE,
    TICKER_URL,
    UPDATE_INTERVAL_APPROACHING,
    UPDATE_INTERVAL_IDLE,
    UPDATE_INTERVAL_LIVE,
    UPDATE_INTERVAL_PRE_GAME,
)

_LOGGER = logging.getLogger(__name__)

try:
    from aiohttp import ClientTimeout
    _TIMEOUT = ClientTimeout(total=API_TIMEOUT)
except ImportError:
    _TIMEOUT = None

# Fields the list endpoint carries but the detail endpoint omits.
_SUMMARY_KEYS = (
    "homeclubid", "awayclubid", "homelogoid", "awaylogoid",
    "homelogourl", "awaylogourl", "hometeam_short", "awayteam_short",
    "homerank", "awayrank", "matchday",
)

# Ticker entries carry this minute when they hold no game clock at all, which
# is what the promo banners shown between games look like.
_TICKER_NO_CLOCK_MINUTE = -99

# Length of a regular period in seconds, used to turn a period plus a clock
# into one monotonically growing number the cards can compare.
_PERIOD_SECONDS = 20 * 60


def format_scorer(player: dict | None) -> str | None:
    """Format a player name from any of the API's person objects.

    The id key differs by endpoint: a goal scorer and a penalised player carry
    "id", the nomination and the goalies of a game detail carry "playerid",
    and a match official carries "officialid". All three shapes are accepted
    here, because requiring "id" alone silently produced empty names for the
    lineup and for the goaltenders of a game.
    """
    if not player:
        return None
    if not (
        player.get("id")
        or player.get("playerid")
        or player.get("officialid")
    ):
        return None
    # Some roster entries carry a trailing space inside the first name, so the
    # parts are joined on collapsed whitespace rather than concatenated.
    parts = f"{player.get('firstname') or ''} {player.get('lastname') or ''}".split()
    return " ".join(parts) or None


def photo_url(photo_id: int | None, width: int = 200) -> str | None:
    """Build a scaled asset URL for a player photo or a club logo id.

    The unscaled asset runs into megabytes per player, so every consumer gets
    a width-limited variant.
    """
    if not photo_id:
        return None
    return f"{API_BASE}/image/{photo_id}?width={width}"


def _parse_matchstart(matchstart: str | None) -> datetime | None:
    """Parse a matchstart string into a timezone-aware datetime."""
    if not matchstart:
        return None
    try:
        return datetime.strptime(matchstart, "%Y-%m-%d %H:%M:%S %z")
    except (ValueError, TypeError):
        return None


def _format_local(matchstart: str | None) -> str | None:
    """Format a matchstart UTC string in the HA-configured local timezone."""
    dt = _parse_matchstart(matchstart)
    if not dt:
        return matchstart
    return dt_util.as_local(dt).isoformat()


def _is_adler_home(game: dict) -> bool:
    """Check if Adler is the home team."""
    return game.get("homeclubid") == ADLER_CLUB_ID or "Adler" in (game.get("hometeam") or "")


def _adler_score(game: dict) -> tuple[int, int]:
    """Return (adler_score, opponent_score) for a game."""
    h = game.get("homescore", 0) or 0
    a = game.get("awayscore", 0) or 0
    if _is_adler_home(game):
        return h, a
    return a, h


def _int(value, default: int = 0) -> int:
    """Read a number the API may deliver as null."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _text(value) -> str | None:
    """Strip a string field, which the table endpoint pads with spaces."""
    if value is None:
        return None
    stripped = str(value).strip()
    return stripped or None


class AdlerMannheimCoordinator(DataUpdateCoordinator):
    """Coordinator that fetches Adler Mannheim game, table and squad data.

    One coordinator serves every entity, but the endpoints behind it move at
    very different speeds: the ticker carries the running clock, the game list
    changes per goal, and the table or the squad change at most daily. Each
    endpoint group therefore has its own throttle and is skipped on ticks where
    its last payload is still young enough, so a ten-second live tick does not
    turn into six squad fetches a minute.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(
            hass, _LOGGER, name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL_IDLE),
        )
        self._current_game_id: int | None = None
        self._known_goal_ids: set[int] = set()
        self._known_penalty_ids: set[int] = set()
        self._known_periods: int = 0
        self._was_live: bool = False
        self._payloads: dict[str, object] = {}
        self._fetched_at: dict[str, float] = {}

    # ── Fetching ──────────────────────────────────────────

    async def _get_json(self, session, url: str):
        """Fetch one URL and return the decoded payload."""
        kw = {"timeout": _TIMEOUT} if _TIMEOUT else {}
        async with session.get(url, **kw) as resp:
            if resp.status != 200:
                raise UpdateFailed(f"{url} returned {resp.status}")
            return await resp.json()

    async def _maybe_fetch(self, session, group: str, url: str, throttle: int):
        """Fetch an endpoint group unless its last payload is still fresh.

        A failed secondary fetch keeps the previous payload instead of taking
        the whole update down, so a hiccup on the table endpoint cannot blank
        the scoreboard during a game.
        """
        now = time.monotonic()
        age = now - self._fetched_at.get(group, 0.0)
        if group in self._payloads and age < throttle:
            return self._payloads[group]

        try:
            payload = await self._get_json(session, url)
        except Exception as err:
            if group in self._payloads:
                _LOGGER.debug("Keeping cached %s after fetch error: %s", group, err)
                return self._payloads[group]
            _LOGGER.warning("Could not fetch %s: %s", group, err)
            return None

        self._payloads[group] = payload
        self._fetched_at[group] = now
        return payload

    async def _async_update_data(self) -> dict:
        """Fetch everything that is due and assemble the entity payload."""
        session = async_get_clientsession(self.hass)
        was_live = self._was_live

        games = await self._fetch_game_list(session, was_live)

        finished = sorted(
            (g for g in games if g.get("status") == "FINAL"),
            key=lambda x: x.get("matchstart", ""), reverse=True,
        )
        running = [g for g in games if g.get("status") == "LIVE"]
        future = sorted(
            (g for g in games if g.get("status") == "FUTURE"),
            key=lambda x: x.get("matchstart", ""),
        )

        last_summary = finished[0] if finished else None
        current_summary = running[0] if running else None
        next_summary = future[0] if future else None

        running_throttle = THROTTLE_GAMES_LIVE if was_live else 0
        side_throttle = THROTTLE_DETAIL_SIDE_LIVE if was_live else 0

        last_game, current_game, next_game = await asyncio.gather(
            self._fetch_detail(session, "last", last_summary, side_throttle),
            self._fetch_detail(session, "current", current_summary, running_throttle),
            self._fetch_detail(session, "next", next_summary, side_throttle),
        )

        is_live = current_game is not None

        ticker_payload = await self._maybe_fetch(
            session, "ticker", TICKER_URL,
            THROTTLE_TICKER_LIVE if (is_live or was_live) else THROTTLE_TICKER_IDLE,
        )
        standings_payload = await self._maybe_fetch(
            session, "standings", STANDINGS_URL, THROTTLE_STANDINGS,
        )
        team_payload = await self._maybe_fetch(
            session, "team", TEAM_URL, THROTTLE_TEAM,
        )
        roster_payload = await self._maybe_fetch(
            session, "roster", PLAYER_URL, THROTTLE_ROSTER,
        )

        reference_game = current_game or last_game

        new_interval = self._calculate_interval(is_live, next_game or next_summary)
        if self.update_interval != timedelta(seconds=new_interval):
            self.update_interval = timedelta(seconds=new_interval)

        self._detect_events(current_game, current_summary)

        return {
            "last_game": last_game,
            "current_game": current_game,
            "next_game": next_game,
            "is_live": is_live,
            "season_stats": self._compute_season_stats(games, COMPETITION_LEAGUE),
            "competitions": self._compute_competition_records(games),
            "playoff_series": self._compute_playoff_series(games),
            "game_stats": self._extract_game_stats(reference_game),
            "lineup": self._extract_lineup(reference_game),
            "clock": self._extract_clock(ticker_payload, current_game),
            "ticker": self._extract_ticker(ticker_payload),
            "standings": self._parse_standings(standings_payload),
            "team": self._parse_team(team_payload),
            "roster": self._parse_roster(roster_payload),
            "all_games": games,
        }

    async def _fetch_game_list(self, session, was_live: bool) -> list[dict]:
        """Fetch the game list, the one endpoint an update cannot do without."""
        throttle = THROTTLE_GAMES_LIVE if was_live else 0
        now = time.monotonic()
        age = now - self._fetched_at.get("games", 0.0)
        cached = self._payloads.get("games")
        if isinstance(cached, list) and age < throttle:
            return cached

        try:
            games = await self._get_json(session, GAME_URL)
        except UpdateFailed:
            raise
        except Exception as err:
            raise UpdateFailed(f"Error fetching games: {err}") from err

        if not isinstance(games, list):
            raise UpdateFailed("Game list endpoint did not return a list")

        self._payloads["games"] = games
        self._fetched_at["games"] = now
        return games

    async def _fetch_detail(
        self,
        session,
        slot: str,
        summary: dict | None,
        throttle: int,
    ) -> dict | None:
        """Fetch one game detail and fold in the fields only the list carries.

        Each of the three slots keeps its own last response and re-reads it
        only once the throttle has passed or a different game has moved into
        the slot. Without that the three details would dominate the traffic at
        the short live tick, for data the CDN serves unchanged for minutes.
        """
        if not summary:
            return None

        game_id = summary.get("id")
        if not game_id:
            return summary

        group = f"detail_{slot}"
        cached = self._payloads.get(group)
        is_same_game = isinstance(cached, dict) and cached.get("id") == game_id
        age = time.monotonic() - self._fetched_at.get(group, 0.0)

        if is_same_game and age < throttle:
            detail = cached
        else:
            try:
                detail = await self._get_json(session, f"{BASE_URL}{game_id}")
            except Exception as err:
                _LOGGER.warning("Failed to fetch detail for game %s: %s", game_id, err)
                return cached if is_same_game else summary

            if not isinstance(detail, dict):
                return summary

            self._payloads[group] = detail
            self._fetched_at[group] = time.monotonic()

        for key in _SUMMARY_KEYS:
            if key in summary and key not in detail:
                detail[key] = summary[key]
        return detail

    # ── Records ───────────────────────────────────────────

    @staticmethod
    def _record_from_games(games: list[dict]) -> dict:
        """Build a win/loss record over a list of finished games.

        Regulation and overtime results are told apart by the goals the API
        books into its overtime and shootout buckets, so a shootout win counts
        two points and a regulation win three, the way the DEL counts them.
        """
        regulation_wins = ot_wins = losses = otl = 0
        goals_for = goals_against = 0
        home_w = home_l = home_otl = 0
        away_w = away_l = away_otl = 0
        points = 0
        results = []

        for game in games:
            adler_home = _is_adler_home(game)
            adler_goals, opponent_goals = _adler_score(game)
            goals_for += adler_goals
            goals_against += opponent_goals

            beyond_regulation = (
                _int(game.get("periods"), 3) > 3
                or _int(game.get("otnumberperiods")) > 0
                or _int(game.get("home_goals_overtime")) > 0
                or _int(game.get("away_goals_overtime")) > 0
                or _int(game.get("home_goals_shootout")) > 0
                or _int(game.get("away_goals_shootout")) > 0
            )
            opponent = game.get("awayteam") if adler_home else game.get("hometeam")

            if adler_goals > opponent_goals and beyond_regulation:
                ot_wins += 1
                points += 2
                result = "OTW"
                if adler_home:
                    home_w += 1
                else:
                    away_w += 1
            elif adler_goals > opponent_goals:
                regulation_wins += 1
                points += 3
                result = "W"
                if adler_home:
                    home_w += 1
                else:
                    away_w += 1
            elif beyond_regulation:
                otl += 1
                points += 1
                result = "OTL"
                if adler_home:
                    home_otl += 1
                else:
                    away_otl += 1
            else:
                losses += 1
                result = "L"
                if adler_home:
                    home_l += 1
                else:
                    away_l += 1

            results.append({
                "date": game.get("matchstart", ""),
                "result": result,
                "opponent": opponent,
                "score": f"{adler_goals}:{opponent_goals}",
                "is_home": adler_home,
                "competition": game.get("competitiontype"),
            })

        results.sort(key=lambda entry: entry["date"])

        streak_marker = ""
        streak_count = 0
        for entry in reversed(results):
            marker = "W" if entry["result"] in ("W", "OTW") else "L"
            if not streak_marker:
                streak_marker = marker
                streak_count = 1
            elif marker == streak_marker:
                streak_count += 1
            else:
                break
        streak = f"{streak_marker}{streak_count}" if streak_marker else ""

        wins = regulation_wins + ot_wins
        total = wins + losses + otl

        return {
            "wins": wins,
            "regulation_wins": regulation_wins,
            "ot_wins": ot_wins,
            "losses": losses,
            "otl": otl,
            "points": points,
            "games_played": total,
            "goals_for": goals_for,
            "goals_against": goals_against,
            "goal_diff": goals_for - goals_against,
            "home_record": f"{home_w}-{home_l}-{home_otl}",
            "away_record": f"{away_w}-{away_l}-{away_otl}",
            "streak": streak,
            "last_5": [entry["result"] for entry in results[-5:]],
            "win_pct": round(wins / total * 100, 1) if total else 0,
            "results": results,
        }

    @classmethod
    def _compute_season_stats(cls, games: list[dict], competition: str) -> dict:
        """Build the record for one competition."""
        selected = [
            game for game in games
            if game.get("status") == "FINAL"
            and game.get("competitiontype") == competition
        ]
        return cls._record_from_games(selected)

    @classmethod
    def _compute_competition_records(cls, games: list[dict]) -> dict:
        """Build one record per competition plus a combined competitive record.

        Counting the league alone leaves the CHL campaign out of every number
        on the dashboard, so each competition gets its own record and the
        exhibition games stay out of the combined one.
        """
        finished = [game for game in games if game.get("status") == "FINAL"]

        present = []
        for game in finished:
            competition = game.get("competitiontype")
            if competition and competition not in present:
                present.append(competition)

        by_competition = {}
        for competition in present:
            record = cls._record_from_games(
                [game for game in finished if game.get("competitiontype") == competition]
            )
            record["title"] = COMPETITION_TITLES.get(competition, competition)
            by_competition[competition] = record

        competitive = cls._record_from_games(
            [
                game for game in finished
                if game.get("competitiontype") not in COMPETITIONS_EXHIBITION
            ]
        )
        competitive["title"] = "Pflichtspiele"

        return {"total": competitive, "by_competition": by_competition}

    @staticmethod
    def _compute_playoff_series(games: list[dict]) -> dict | None:
        """Compute the current playoff series status."""
        po_finished = [
            game for game in games
            if game.get("competitiontype") == COMPETITION_PLAYOFF
            and game.get("status") == "FINAL"
        ]
        po_future = [
            game for game in games
            if game.get("competitiontype") == COMPETITION_PLAYOFF
            and game.get("status") == "FUTURE"
        ]

        if not po_finished and not po_future:
            return None

        all_po = sorted(po_finished + po_future, key=lambda x: x.get("matchstart", ""))
        if not all_po:
            return None

        latest = all_po[-1]
        if _is_adler_home(latest):
            opponent_name = latest.get("awayteam", "?")
        else:
            opponent_name = latest.get("hometeam", "?")

        adler_wins = 0
        opponent_wins = 0
        series_games = []

        for game in sorted(po_finished, key=lambda x: x.get("matchstart", "")):
            is_home = _is_adler_home(game)
            opponent = game.get("awayteam") if is_home else game.get("hometeam")
            if opponent != opponent_name:
                continue
            adler_goals, opponent_goals = _adler_score(game)
            if adler_goals > opponent_goals:
                adler_wins += 1
            else:
                opponent_wins += 1
            series_games.append({
                "date": game.get("matchstart", ""),
                "score": f"{adler_goals}:{opponent_goals}",
                "is_home": is_home,
                "won": adler_goals > opponent_goals,
            })

        best_of = latest.get("bestOf", 7) or 7

        return {
            "opponent": opponent_name,
            "adler_wins": adler_wins,
            "opp_wins": opponent_wins,
            "best_of": best_of,
            "games": series_games,
            "is_active": (
                adler_wins < (best_of // 2 + 1)
                and opponent_wins < (best_of // 2 + 1)
            ),
        }

    # ── Game detail ───────────────────────────────────────

    @staticmethod
    def _extract_game_stats(game: dict | None) -> dict | None:
        """Extract the team comparison from a game detail response."""
        if not game:
            return None

        adler_home = _is_adler_home(game)

        def pick(home_key: str, away_key: str) -> tuple[int, int]:
            home_value = _int(game.get(home_key))
            away_value = _int(game.get(away_key))
            return (home_value, away_value) if adler_home else (away_value, home_value)

        shots_a, shots_o = pick("home_shotsongoal", "away_shotsongoal")
        missed_a, missed_o = pick("home_shotsoffgoal", "away_shotsoffgoal")
        faceoffs_won_a, faceoffs_won_o = pick("home_faceoffswon", "away_faceoffswon")
        faceoff_pct_a, faceoff_pct_o = pick(
            "home_faceOffsWonPercent", "away_faceOffsWonPercent"
        )
        pp_goals_a, pp_goals_o = pick("home_powerplaygoals", "away_powerplaygoals")
        pp_adv_a, pp_adv_o = pick(
            "home_powerplayadvantages", "away_powerplayadvantages"
        )
        sh_goals_a, sh_goals_o = pick(
            "home_shorthandedgoals", "away_shorthandedgoals"
        )
        pim_a, pim_o = pick("home_penaltyminutes", "away_penaltyminutes")
        saves_a, saves_o = pick("home_saves", "away_saves")

        def efficiency(goals: int, advantages: int) -> float:
            return round(goals / advantages * 100, 1) if advantages else 0.0

        period_goals = []
        period_shots = []
        for period in (1, 2, 3):
            goals_a, goals_o = pick(
                f"home_goals_period{period}", f"away_goals_period{period}"
            )
            shots_period_a, shots_period_o = pick(
                f"home_shots_period{period}", f"away_shots_period{period}"
            )
            period_goals.append({
                "period": period,
                "adler": goals_a,
                "opponent": goals_o,
            })
            period_shots.append({
                "period": period,
                "adler": shots_period_a,
                "opponent": shots_period_o,
            })

        goalies = [
            {
                "name": format_scorer(entry),
                "jersey": entry.get("jersey"),
                "is_adler": (entry.get("side") == "home") == adler_home,
                "minutes": entry.get("min"),
                "decision": entry.get("decision"),
                "goals_against": _int(entry.get("goalsagainst")),
                "saves": _int(entry.get("saves")),
                "photo": photo_url(entry.get("photoid")),
            }
            for entry in (game.get("goalies") or [])
        ]

        officials = [
            {
                "name": format_scorer(entry),
                "role": entry.get("role"),
            }
            for entry in (game.get("officials") or [])
        ]

        stars = [
            {
                "name": format_scorer(entry),
                "jersey": entry.get("jersey"),
                "rank": entry.get("rank") or entry.get("number"),
            }
            for entry in (game.get("stars") or [])
        ]

        news = [
            {
                "headline": _text(entry.get("headline")),
                "date": entry.get("date"),
                "url": (
                    f"{SITE_URL}{entry['origURL']}"
                    if entry.get("origURL")
                    else None
                ),
            }
            for entry in (game.get("news") or [])[:3]
        ]

        return {
            "status": game.get("status"),
            "shots_adler": shots_a,
            "shots_opponent": shots_o,
            "shots_missed_adler": missed_a,
            "shots_missed_opponent": missed_o,
            "faceoff_pct_adler": faceoff_pct_a,
            "faceoff_pct_opponent": faceoff_pct_o,
            "faceoffs_won_adler": faceoffs_won_a,
            "faceoffs_won_opponent": faceoffs_won_o,
            "powerplay_adler": f"{pp_goals_a}/{pp_adv_a}",
            "powerplay_opponent": f"{pp_goals_o}/{pp_adv_o}",
            "powerplay_pct_adler": efficiency(pp_goals_a, pp_adv_a),
            "powerplay_pct_opponent": efficiency(pp_goals_o, pp_adv_o),
            "shorthanded_goals_adler": sh_goals_a,
            "shorthanded_goals_opponent": sh_goals_o,
            "pim_adler": pim_a,
            "pim_opponent": pim_o,
            "saves_adler": saves_a,
            "saves_opponent": saves_o,
            "period_goals": period_goals,
            "period_shots": period_shots,
            "goalies": goalies,
            "officials": officials,
            "stars": stars,
            "news": news,
            "attendance": game.get("attendance"),
            "arena": game.get("arena"),
            "matchday": game.get("matchday"),
            "competition": game.get("competitionshorttitle") or game.get("competitiontype"),
            "rank_adler": (
                game.get("homerank") if adler_home else game.get("awayrank")
            ),
            "rank_opponent": (
                game.get("awayrank") if adler_home else game.get("homerank")
            ),
            "link_livestream": game.get("link_Livestream"),
            "link_ticketing": game.get("link_Ticketing"),
            "tickets_soldout": game.get("ticketsSoldout"),
        }

    @staticmethod
    def _extract_lineup(game: dict | None) -> dict | None:
        """Read who was on the Adler game sheet.

        The nomination names the bench with jersey and position, but every
        per-player counter it carries is zero, in a 6:1 win just as in a 1:4
        defeat, so this is a list of who played and not a scoring sheet.
        Individual season numbers come from the team endpoint, and the
        per-game goaltender numbers from the game's own goalies array.

        Only the Adler side is ever delivered, home or away depending on where
        the game was played, so entries from the other side are dropped rather
        than offered as an opponent lineup.
        """
        if not game:
            return None

        nomination = game.get("nomination") or []
        if not nomination:
            return None

        adler_home = _is_adler_home(game)
        players = []
        by_position: dict[str, list[dict]] = {}

        for entry in nomination:
            if (entry.get("side") == "home") != adler_home:
                continue
            position = _text(entry.get("position")) or "Unbekannt"
            player = {
                "name": format_scorer(entry),
                "jersey": entry.get("jersey"),
                "position": position,
                "position_detail": _text(entry.get("position_detail")),
            }
            players.append(player)
            by_position.setdefault(position, []).append(player)

        if not players:
            return None

        def by_jersey(entry: dict) -> tuple[int, str]:
            """Sort by shirt number, keeping non-numeric jerseys at the end."""
            jersey = str(entry.get("jersey") or "")
            return (_int(jersey, 999), jersey)

        players.sort(key=by_jersey)
        for bench in by_position.values():
            bench.sort(key=by_jersey)

        return {
            "adler": players,
            "adler_count": len(players),
            "by_position": by_position,
        }

    # ── Ticker and clock ──────────────────────────────────

    @staticmethod
    def _extract_ticker(payload) -> dict | None:
        """Reduce the ticker payload to its entries.

        The endpoint doubles as the arena promo channel, so banner entries are
        kept apart from the entries that carry a game clock.
        """
        if not isinstance(payload, dict):
            return None

        events = payload.get("tickerevents") or []
        live = []
        banners = []

        for entry in events:
            has_clock = _int(entry.get("min"), _TICKER_NO_CLOCK_MINUTE) != _TICKER_NO_CLOCK_MINUTE
            item = {
                "type": _text(entry.get("type")),
                "period": _int(entry.get("period")),
                "minute": _int(entry.get("min"), _TICKER_NO_CLOCK_MINUTE),
                "second": _int(entry.get("sec")),
                "headline": _text(entry.get("headline")),
                "text": _text(entry.get("text")),
                "team": _text(entry.get("teamname")),
            }
            if has_clock:
                live.append(item)
            else:
                banners.append(item)

        return {
            "events": live,
            "banners": banners,
            "event_count": len(live),
            "types": sorted({str(entry.get("type")) for entry in events}),
        }

    @staticmethod
    def _extract_clock(payload, current_game: dict | None) -> dict | None:
        """Derive the game clock from the ticker.

        The ticker is the only endpoint that carries a period with minutes and
        seconds, so it is the clock source. Its entries are not guaranteed to
        arrive in order, hence the latest one by period and time wins. When no
        entry carries a clock the sensor still reports the period the score
        suggests, which keeps the scoreboard honest instead of showing a
        hardcoded time.
        """
        candidates = []
        if isinstance(payload, dict):
            for entry in payload.get("tickerevents") or []:
                minute = _int(entry.get("min"), _TICKER_NO_CLOCK_MINUTE)
                if minute == _TICKER_NO_CLOCK_MINUTE or minute < 0:
                    continue
                period = _int(entry.get("period"))
                if period < 1:
                    continue
                candidates.append((period, minute, _int(entry.get("sec")), entry))

        if candidates:
            period, minute, second, entry = max(candidates, key=lambda item: item[:3])
            return {
                "source": "ticker",
                "period": period,
                "minute": minute,
                "second": second,
                "clock": f"{minute:02d}:{second:02d}",
                "elapsed_seconds": (period - 1) * _PERIOD_SECONDS + minute * 60 + second,
                "running": bool(current_game),
                "headline": _text(entry.get("headline")),
                "text": _text(entry.get("text")),
            }

        if not current_game:
            return None

        period = 1
        for index in (3, 2, 1):
            if current_game.get(f"home_goals_period{index}") is not None:
                period = index
                break
        if _int(current_game.get("otnumberperiods")) > 0:
            period = 4

        return {
            "source": "period",
            "period": period,
            "minute": None,
            "second": None,
            "clock": None,
            "elapsed_seconds": None,
            "running": True,
            "headline": None,
            "text": None,
        }

    # ── Table, team and squad ─────────────────────────────

    @staticmethod
    def _parse_standings(payload) -> dict | None:
        """Reduce the table endpoint to one entry per competition group."""
        if not isinstance(payload, dict):
            return None

        groups = {}
        adler_rank = None
        adler_row = None

        for key, group in payload.items():
            if not isinstance(group, dict):
                continue

            teams = []
            for row in group.get("scores") or []:
                games_played = _int(row.get("gamesplayed"))
                wins = _int(row.get("wins"))
                losses = _int(row.get("losses"))
                overtime_wins = _int(row.get("overtimewins"))
                overtime_losses = _int(row.get("overtimelosses"))
                shootout_wins = _int(row.get("shootoutwins"))
                points = _int(row.get("points"))

                # The feed has overtimewins, overtimelosses and shootoutwins
                # but no shootoutlosses, so a team that lost a shootout is one
                # game and one point short of its own breakdown. The missing
                # count is the remainder of the played games, and the published
                # points confirm it: derived this way the point sum matched all
                # 14 rows of the table, including the three that were short.
                shootout_losses = max(
                    0,
                    games_played
                    - (wins + losses + overtime_wins + overtime_losses + shootout_wins),
                )
                wins_overtime = overtime_wins + shootout_wins
                losses_overtime = overtime_losses + shootout_losses
                derived_points = wins * 3 + wins_overtime * 2 + losses_overtime

                team = {
                    "rank": _int(row.get("rank")),
                    "club_id": row.get("clubID"),
                    "name": _text(row.get("clubTitle")),
                    "short": _text(row.get("clubShortTitle")),
                    "logo": photo_url(row.get("clubLogoID"), width=48),
                    "games_played": games_played,
                    "wins": wins,
                    "losses": losses,
                    "overtime_wins": overtime_wins,
                    "overtime_losses": overtime_losses,
                    "shootout_wins": shootout_wins,
                    "shootout_losses": shootout_losses,
                    "wins_overtime": wins_overtime,
                    "losses_overtime": losses_overtime,
                    "record": f"{wins}-{wins_overtime}-{losses_overtime}-{losses}",
                    # False means the derivation no longer reconciles with the
                    # published points, so the breakdown must not be trusted.
                    "record_reconciles": derived_points == points,
                    "points": points,
                    "points_per_game": row.get("pointsPerGame"),
                    "goals_for": _int(row.get("goalsfor")),
                    "goals_against": _int(row.get("goalsagainst")),
                    "goal_diff": _int(row.get("goalsfor")) - _int(row.get("goalsagainst")),
                    "penalty_minutes": _int(row.get("penaltyminutes")),
                    "home_record": _text(row.get("homerecord")),
                    "road_record": _text(row.get("roadrecord")),
                    "streak": _text(row.get("teamstreak")),
                    "is_adler": row.get("clubID") == ADLER_CLUB_ID,
                }
                teams.append(team)
                if team["is_adler"] and adler_row is None:
                    adler_row = team
                    adler_rank = team["rank"]

            teams.sort(key=lambda entry: entry["rank"] or 99)

            groups[key] = {
                "title": _text(group.get("title")) or key,
                "type": _text(group.get("type")) or key,
                "updated": group.get("timestamp"),
                "playoff_cut": _int(group.get("numberRed")) or None,
                "playoff_cut_legend": _text(group.get("legendRed")),
                "qualification_cut": _int(group.get("numberBlue")) or None,
                "qualification_cut_legend": _text(group.get("legendBlue")),
                "teams": teams,
            }

        if not groups:
            return None

        return {
            "groups": groups,
            "adler_rank": adler_rank,
            "adler": adler_row,
        }

    @staticmethod
    def _parse_team(payload) -> dict | None:
        """Reduce the team endpoint to the official record plus the leaders."""
        if not isinstance(payload, dict):
            return None

        def flatten(entries: list[dict], keys: tuple[str, ...]) -> list[dict]:
            """Collapse each player to the competition they have played most."""
            players = []
            for entry in entries or []:
                competitions = entry.get("competitions") or []
                if not competitions:
                    continue
                best = max(
                    competitions,
                    key=lambda competition: _int(
                        competition.get("gamesplayed"), _int(competition.get("points"))
                    ),
                )
                player = {
                    "name": format_scorer(entry),
                    "jersey": entry.get("jersey"),
                    "position": entry.get("position_detail") or entry.get("position"),
                    "injured": bool(entry.get("injured")),
                    "photo": photo_url(entry.get("photoid")),
                    "competition": _text(best.get("type")),
                }
                for key in keys:
                    player[key] = best.get(key)
                players.append(player)
            return players

        scorers = flatten(payload.get("scorer"), ("goals", "assists", "points"))
        scorers.sort(
            key=lambda player: (
                _int(player.get("points")),
                _int(player.get("goals")),
            ),
            reverse=True,
        )

        goalies = flatten(
            payload.get("goalies"),
            ("gamesplayed", "minutes", "goalsagainst", "goalsagainstaverage",
             "savepercentage", "shutouts"),
        )
        goalies.sort(key=lambda player: _int(player.get("minutes")), reverse=True)

        return {
            "updated": payload.get("timestamp"),
            "rank": _int(payload.get("rank")) or None,
            "points": _int(payload.get("points")),
            "games_played": _int(payload.get("gamesPlayed")),
            "wins": _int(payload.get("wins")),
            "losses": _int(payload.get("losses")),
            "goals_for": _int(payload.get("goalsfor")),
            "goals_against": _int(payload.get("goalsagainst")),
            "penalty_minutes": _int(payload.get("penaltyminutes")),
            "home_record": "{}-{}-{}-{}".format(
                _int(payload.get("homeWins")),
                _int(payload.get("homeOtWins")),
                _int(payload.get("homeOtLosses")),
                _int(payload.get("homeLosses")),
            ),
            "away_record": "{}-{}-{}-{}".format(
                _int(payload.get("awayWins")),
                _int(payload.get("awayOtWins")),
                _int(payload.get("awayOtLosses")),
                _int(payload.get("awayLosses")),
            ),
            "last_ten": "{}-{}-{}-{}".format(
                _int(payload.get("lasttenWins")),
                _int(payload.get("lasttenOtWins")),
                _int(payload.get("lasttenOtLosses")),
                _int(payload.get("lasttenLosses")),
            ),
            "top_scorers": scorers[:10],
            "goalies": goalies,
        }

    @staticmethod
    def _parse_roster(payload) -> dict | None:
        """Reduce the squad endpoint to players grouped by position."""
        if not isinstance(payload, dict):
            return None

        groups: dict[str, list[dict]] = {}
        injured = []
        players = []

        for entry in payload.get("players") or []:
            position = _text(entry.get("position")) or "Unbekannt"
            player = {
                "name": format_scorer(entry),
                "jersey": entry.get("jersey"),
                "position": position,
                "position_detail": _text(entry.get("position_detail")),
                "nationality": _text(entry.get("nationallity")),
                "injured": bool(entry.get("injured")),
                "loaned": bool(entry.get("loaned")),
                "job": _text(entry.get("job")),
                "photo": photo_url(entry.get("photoid")),
            }
            players.append(player)
            groups.setdefault(position, []).append(player)
            if player["injured"]:
                injured.append(player)

        if not players:
            return None

        for bench in groups.values():
            bench.sort(key=lambda player: (player["name"] or ""))

        return {
            "count": len(players),
            "by_position": groups,
            "injured": injured,
            "injured_count": len(injured),
            "team_photo": photo_url(payload.get("teamfoto"), width=800),
        }

    # ── Interval calculation ──────────────────────────────

    @staticmethod
    def _calculate_interval(is_live: bool, next_game: dict | None) -> int:
        if is_live:
            return UPDATE_INTERVAL_LIVE
        if next_game:
            matchstart = _parse_matchstart(next_game.get("matchstart"))
            if matchstart:
                seconds_until = (matchstart - datetime.now(timezone.utc)).total_seconds()
                if seconds_until <= 600:
                    return UPDATE_INTERVAL_PRE_GAME
                if seconds_until <= 3600:
                    return UPDATE_INTERVAL_APPROACHING
        return UPDATE_INTERVAL_IDLE

    # ── Event detection ───────────────────────────────────

    def _is_adler_goal(self, goal: dict, game: dict) -> bool:
        adler_home = game.get("homeclubid") == ADLER_CLUB_ID
        adler_logoid = game.get("homelogoid") if adler_home else game.get("awaylogoid")
        if adler_logoid is not None:
            return goal.get("teamlogoid") == adler_logoid
        return adler_home

    def _detect_events(self, current_game: dict | None, summary: dict | None) -> None:
        game_id = current_game.get("id") if current_game else None
        is_live = current_game is not None

        if game_id != self._current_game_id:
            if self._was_live:
                self.hass.bus.async_fire(EVENT_GAME_END)
                _LOGGER.info("Game ended")

            self._current_game_id = game_id
            self._known_goal_ids.clear()
            self._known_penalty_ids.clear()
            self._known_periods = 0

            if current_game:
                for goal in current_game.get("goals", []):
                    if goal_id := goal.get("id"):
                        self._known_goal_ids.add(goal_id)
                for penalty in current_game.get("penalties", []):
                    if penalty_id := penalty.get("id"):
                        self._known_penalty_ids.add(penalty_id)

                if summary:
                    for key in _SUMMARY_KEYS:
                        if key in summary and key not in current_game:
                            current_game[key] = summary[key]

                self.hass.bus.async_fire(EVENT_GAME_START, {
                    "game_id": game_id,
                    "home_team": current_game.get("hometeam"),
                    "away_team": current_game.get("awayteam"),
                    "match_start": _format_local(current_game.get("matchstart")),
                })

            self._was_live = is_live
            return

        self._was_live = is_live
        if not current_game:
            return

        if summary:
            for key in _SUMMARY_KEYS:
                if key in summary and key not in current_game:
                    current_game[key] = summary[key]

        for goal in current_game.get("goals", []):
            goal_id = goal.get("id")
            if not goal_id or goal_id in self._known_goal_ids:
                continue
            self._known_goal_ids.add(goal_id)
            scorer = goal.get("scorer", {})
            self.hass.bus.async_fire(EVENT_GOAL, {
                "goal_id": goal_id,
                "is_adler_goal": self._is_adler_goal(goal, current_game),
                "period": goal.get("period"),
                "time": goal.get("time"),
                "goaltype": goal.get("goaltype"),
                "scorer": format_scorer(scorer),
                "scorer_jersey": scorer.get("jersey") if scorer else None,
                "assist1": format_scorer(goal.get("assist1", {})),
                "assist2": format_scorer(goal.get("assist2", {})),
                "score_home": current_game.get("homescore"),
                "score_away": current_game.get("awayscore"),
                "home_team": current_game.get("hometeam"),
                "away_team": current_game.get("awayteam"),
            })

        for penalty in current_game.get("penalties", []):
            penalty_id = penalty.get("id")
            if not penalty_id or penalty_id in self._known_penalty_ids:
                continue
            self._known_penalty_ids.add(penalty_id)
            player = penalty.get("player", {})
            self.hass.bus.async_fire(EVENT_PENALTY, {
                "player": format_scorer(player),
                "infraction": penalty.get("infraction"),
                "minutes": penalty.get("penaltytime"),
                "period": penalty.get("period"),
                "time": penalty.get("time"),
            })

        for period in (1, 2, 3):
            booked = current_game.get(f"home_goals_period{period}") is not None
            if booked and period > self._known_periods:
                self._known_periods = period
                self.hass.bus.async_fire(EVENT_PERIOD_END, {"period": period})
