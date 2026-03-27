"""Constants for the Adler Mannheim integration."""

DOMAIN = "adlermannheim"

BASE_URL = "https://www.adler-mannheim.de/jsonapi/game/"
ADLER_CLUB_ID = 6
ADLER_TEAM_NAME = "Adler Mannheim"

# Update intervals in seconds
UPDATE_INTERVAL_LIVE = 30
UPDATE_INTERVAL_PRE_GAME = 60
UPDATE_INTERVAL_APPROACHING = 300
UPDATE_INTERVAL_IDLE = 1800

# API request timeout in seconds
API_TIMEOUT = 15

# Event types for automations
EVENT_GOAL = f"{DOMAIN}_goal"
EVENT_GAME_START = f"{DOMAIN}_game_start"
EVENT_GAME_END = f"{DOMAIN}_game_end"
EVENT_PENALTY = f"{DOMAIN}_penalty"
EVENT_PERIOD_END = f"{DOMAIN}_period_end"
