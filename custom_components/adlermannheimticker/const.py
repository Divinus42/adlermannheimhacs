"""Constants for the Adler Mannheim integration."""

DOMAIN = "adlermannheim"

SITE_URL = "https://www.adler-mannheim.de"
API_BASE = f"{SITE_URL}/jsonapi"

# Kept in this trailing-slash shape because sensor.py derives the asset host
# from it by splitting on "/jsonapi".
BASE_URL = f"{API_BASE}/game/"

GAME_URL = f"{API_BASE}/game"
TICKER_URL = f"{API_BASE}/ticker"
STANDINGS_URL = f"{API_BASE}/standings"
TEAM_URL = f"{API_BASE}/team"
PLAYER_URL = f"{API_BASE}/player"
NEWS_URL = f"{API_BASE}/news"

ADLER_CLUB_ID = 6
ADLER_TEAM_NAME = "Adler Mannheim"

# Coordinator tick in seconds. The live tick is short so the game clock stays
# close to the arena clock; the heavier endpoints carry their own throttles
# below and are therefore skipped on most ticks.
UPDATE_INTERVAL_LIVE = 10
UPDATE_INTERVAL_PRE_GAME = 60
UPDATE_INTERVAL_APPROACHING = 300
UPDATE_INTERVAL_IDLE = 1800

# Minimum seconds between two fetches of one endpoint group. The API sits
# behind a CDN, so polling an endpoint faster than its cache turnover only
# re-reads the same bytes.
THROTTLE_TICKER_LIVE = 10
THROTTLE_TICKER_IDLE = 600
THROTTLE_GAMES_LIVE = 20
# Three game details are read per update. The last and the next game barely
# move while another game is running, so only the running game follows the
# short throttle above.
THROTTLE_DETAIL_SIDE_LIVE = 300
THROTTLE_STANDINGS = 900
THROTTLE_TEAM = 1800
THROTTLE_ROSTER = 21600

# API request timeout in seconds
API_TIMEOUT = 15

# Competition keys as the API spells them in "competitiontype".
COMPETITION_LEAGUE = "DEL"
COMPETITION_PLAYOFF = "PO"
COMPETITION_CHL = "CHL"
COMPETITION_TEST = "TEST"

# Friendly names for the per-competition record breakdown.
COMPETITION_TITLES = {
    COMPETITION_LEAGUE: "DEL",
    COMPETITION_PLAYOFF: "Playoffs",
    COMPETITION_CHL: "CHL",
    COMPETITION_TEST: "Testspiele",
}

# Results of these competitions stay out of every record.
COMPETITIONS_EXHIBITION = (COMPETITION_TEST,)

# Event types for automations
EVENT_GOAL = f"{DOMAIN}_goal"
EVENT_GAME_START = f"{DOMAIN}_game_start"
EVENT_GAME_END = f"{DOMAIN}_game_end"
EVENT_PENALTY = f"{DOMAIN}_penalty"
EVENT_PERIOD_END = f"{DOMAIN}_period_end"
