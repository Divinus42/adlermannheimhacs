const CARD_VERSION = '21.2.0';

/* Built against two photographs of the arena cube: one at the end of a
   period in a 6:1 league game, one 28 minutes before a Champions League puck
   drop. What that board does, and what this card therefore does too:

   - the score strip is a neutral dark panel, set apart from the video area,
     and the same tone in both competitions. The key visual and the eagle
     live on the surrounding faces, never behind the numbers.
   - the numerals are upright, not italic, and white.
   - the team code is a small letterspaced caption ABOVE its own score
     ("MAN" over "0"), and there are no club crests inside the strip. The
     competition mark sits at each far end instead.
   - the clock sits between the two scores and switches to tenths of a second
     in the closing minute of a period ("0.0"). Before a game it counts the
     kickoff down on the same clock in plain MM:SS ("28:19").
   - a dot above the clock reports the clock itself: green while it runs, red
     at every interruption. The API has no clock-state field, so the card can
     only show the period end and the absence of a game as red.
   - three bars in the club's colours sit under the clock, one per period,
     blue, white, red. The running period's bar is lit, the others dimmed.
     Still photographs made them look identical; watched live the brightness
     moves with the period.
   - the lower LED band runs the pairing during play, the upper keeps the
     competition's wordmark.
   - a penalty reads as plain text, "#75 - 0:15".

   The cube is markedly calmer than a dashboard card wants to be, and that
   restraint is the point. */
const PERIOD_SECONDS = 20 * 60;

/* Below this many seconds remaining the clock counts in tenths, the way the
   board does in the closing minute. */
const TENTHS_BELOW_SECONDS = 60;

/* Game seconds per real second while the clock is taken to be running.
   Measured at the CHL game against Tychy from goal to goal, the only entries
   posted at the moment they are stamped with: 0.65 over the opening period
   including every stoppage. With the stoppages at goals and penalties held
   explicitly (below), the pace between them works out to about 0.75; the
   faceoffs after icings and offsides stay invisible to the API and are what
   this figure still averages over. Overridable per card with `clock_rate`. */
const CLOCK_RATE = 0.75;

/* Real seconds the clock is held after the two stoppages the feed can see.
   The entry arrives some ten seconds after the whistle, so the hold is the
   remainder of a typical stoppage, not its full length. */
const HOLD_AFTER = { Goal: 45, Penalty: 25, Review: 90 };

/* How long a picture keeps the screen before it yields to the squad photo:
   a scorer or a penalised player briefly, as the cube shows a replay and
   returns to the game, a photographer's picture for longer. */
const PICTURE_SECONDS = { Goal: 90, Penalty: 60, Comment: 300, LastGoal: 90 };

/* A picture is also stale once the game itself has moved on: this many game
   seconds after the moment it shows. Wall time alone is not enough, because a
   freshly loaded card has not seen the goal happen and would show it again. */
const STALE_GAME_SECONDS = { Goal: 120, Penalty: 120, LastGoal: 150, Comment: 600 };

/* The club's ticker is open to browsers, and it carries the break countdown
   (title and absolute end time) a few seconds before the sensor does. */
const ADLER_TICKER_URL = 'https://www.adler-mannheim.de/jsonapi/ticker';
const TICKER_POLL_MS = 6000;

/* The puck drops at the end of the break countdown; the period counter in the
   game detail follows some seconds later. Until the feed catches up the card
   runs the new period on its own. */
const DROP_WINDOW_SECONDS = 90;

/* What the lower band of the cube says during a break. */
const BREAK_RING = { CHL: '#CHAMPIONSGOBEYOND' };

const SEEN_STORAGE = 'adler-seen-';
const SEEN_KEEP_MS = 12 * 3600 * 1000;

/* A finished game stays on the board this long before the next game takes over. */
const FINAL_SHOW_MS = 3600 * 1000;
/* Only for a finished game the card never saw go live. */
const ASSUMED_GAME_MS = 9000 * 1000;

const PENALTY_MINUTES = {
  '2 Min': 2,
  '2+2 Min': 4,
  '4 Min': 4,
  '5 Min': 5,
  '10 Min': 10,
};

const GOAL_TYPE_LABELS = {
  ES: 'EVEN STRENGTH',
  PP: 'POWERPLAY',
  SH: 'UNTERZAHL',
  EN: 'EMPTY NET',
  PS: 'PENALTY',
  SO: 'SHOOTOUT',
};

const FALLBACK_BACKGROUNDS = {
  DEL: 'https://s3.adler-mannheim.de/public/Backgrounds/adler-mannheim-del-2.svg',
  PO: 'https://s3.adler-mannheim.de/public/Backgrounds/adler-mannheim-del-2.svg',
  CHL: 'https://s3.adler-mannheim.de/public/Backgrounds/adler-mannheim-chl-1.svg',
};

const FALLBACK_COLORS = {
  DEL: '#00264d',
  PO: '#00264d',
  CHL: '#400045',
};

const FONT_BASE = 'https://www.adler-mannheim.de/_resources/themes/homepage/css/fonts';

/* The crest the club publishes for its own use, carried on the side faces of
   the cube. */
const ADLER_CREST = 'https://s3.adler-mannheim.de/public/AdlerLogos/adler-logo-shadow.png';

const RING_WORDS = {
  CHL: 'CHL.HOCKEY',
  DEL: 'PENNY DEL',
  PO: 'PENNY DEL PLAYOFFS',
};

const DEFAULT_ENTITIES = {
  entity: 'sensor.adler_mannheim_current_game',
  entity_next: 'sensor.adler_mannheim_next_game',
  entity_last: 'sensor.adler_mannheim_last_game',
  entity_clock: 'sensor.adler_mannheim_clock',
  entity_stats: 'sensor.adler_mannheim_game_stats',
  entity_roster: 'sensor.adler_mannheim_roster',
};

/* Photos come out of the API at whatever width the sensor asked for. The
   screen wants them far larger than a list thumbnail, and the endpoint
   scales on demand, so the width is simply rewritten. */
function scaleImage(url, width) {
  if (!url) {
    return null;
  }
  // S3 assets carry their size in the path as base64 of "[width]", e.g.
  // "__ScaleWidthWzI4OF0" for 288, and serve any width the token names.
  // The tokens in the wild carry no base64 padding ("WzI4OF0", not
  // "WzI4OF0="), and that unpadded form is the one proven to resolve.
  if (/__ScaleWidth[A-Za-z0-9+/=]+/.test(url)) {
    const token = btoa(`[${width}]`).replace(/=+$/, '');
    return url.replace(/__ScaleWidth[A-Za-z0-9+/=]+/, `__ScaleWidth${token}`);
  }
  return url.includes('width=')
    ? url.replace(/width=\d+/, `width=${width}`)
    : `${url}${url.includes('?') ? '&' : '?'}width=${width}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/* MM:SS normally, SS.T in the closing minute, mirroring the board. */
function formatClock(totalSeconds) {
  const safe = Math.max(0, totalSeconds);
  if (safe < TENTHS_BELOW_SECONDS) {
    return safe.toFixed(1);
  }
  const whole = Math.ceil(safe);
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
}

function formatPenalty(totalSeconds) {
  const whole = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
}

/* Plain M:SS for the break countdown; the board has no tenths there. */
function formatBreak(totalSeconds) {
  const whole = Math.max(0, Math.ceil(totalSeconds));
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
}

function parseClockToSeconds(text) {
  if (!text) {
    return null;
  }
  const parts = String(text).split(':');
  if (parts.length !== 2) {
    return null;
  }
  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) {
    return null;
  }
  return minutes * 60 + seconds;
}

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* The API is inconsistent about the leading hash: a league game carries
   "#00264D", a Champions League game carries "400045". */
function cssColor(value, fallback) {
  if (!value) {
    return fallback;
  }
  const text = String(value).trim();
  return text ? (text.startsWith('#') ? text : `#${text}`) : fallback;
}

class AdlerMannheimScoreboard extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._goalOverlay = null;
    this._goalPhase = 0;
    this._knownGoalCount = null;
    this._tickHandle = null;
    this._tickRate = 0;
    this._signature = '';
    this._openPanel = null;
    this._anchor = null;
    // First-seen wall time per picture, so a scorer leaves the screen again.
    this._seen = {};
    this._seenGame = null;
    this._pruned = false;
    this._pause = null;
    this._polling = false;
    this._lastPoll = 0;
  }

  setConfig(config) {
    this._config = { ...DEFAULT_ENTITIES, ...(config || {}) };
  }

  static getStubConfig() {
    return { ...DEFAULT_ENTITIES };
  }

  getCardSize() {
    return 10;
  }

  connectedCallback() {
    this._startTicking();
  }

  disconnectedCallback() {
    this._stopTicking();
  }

  set hass(hass) {
    this._hass = hass;
    this._detectNewGoal();
    this._render();
    this._startTicking();
    this._pollTicker();
  }

  /* ── State ───────────────────────────────────────── */

  _state(key) {
    if (!this._hass || !this._config[key]) {
      return null;
    }
    return this._hass.states[this._config[key]] || null;
  }

  _game() {
    const live = this._state('entity');
    if (live && live.attributes && live.attributes.status === 'LIVE') {
      this._noteLive(live.attributes.game_id);
      return { state: live, mode: 'live' };
    }
    const last = this._state('entity_last');
    const hasLast = Boolean(last && last.attributes && last.attributes.game_id);
    if (hasLast && this._finalShown(last.attributes)) {
      return { state: last, mode: 'final' };
    }
    const next = this._state('entity_next');
    if (next && next.attributes && next.attributes.game_id) {
      return { state: next, mode: 'next' };
    }
    if (hasLast) {
      return { state: last, mode: 'final' };
    }
    return null;
  }

  _stats() {
    const stats = this._state('entity_stats');
    return stats ? stats.attributes || {} : {};
  }

  /* ── Clock ───────────────────────────────────────── */

  _clock() {
    const state = this._state('entity_clock');
    if (!state) {
      return null;
    }

    const attrs = state.attributes || {};
    const now = Date.now();
    const pause = this._pauseState(now);

    /* Between periods the board shows the break countdown, not the period. */
    if (pause && pause.phase === 'break') {
      this._anchor = null;
      return {
        period: pause.period,
        elapsedInPeriod: PERIOD_SECONDS,
        elapsedTotal: pause.period * PERIOD_SECONDS,
        remaining: pause.remaining,
        source: 'pause',
        pause,
      };
    }

    let period = attrs.period || null;
    let elapsedAtUpdate = attrs.elapsed_seconds;

    /* The puck drops when the countdown ends; the feed's own period counter
       follows some seconds later, so the card starts the new period itself. */
    if (pause && pause.phase === 'drop') {
      if (!period || period <= pause.period) {
        period = pause.period + 1;
      }
      const floor = pause.period * PERIOD_SECONDS;
      elapsedAtUpdate = Number.isFinite(Number(elapsedAtUpdate)) && elapsedAtUpdate !== null
        ? Math.max(Number(elapsedAtUpdate), floor)
        : floor;
    }

    if (elapsedAtUpdate === null || elapsedAtUpdate === undefined) {
      return { period, remaining: null, elapsedInPeriod: null, elapsedTotal: null, source: attrs.source };
    }

    /* The feed stamps each entry with game time, so between two entries the
       card carries the clock on its own, at the measured pace of a hockey
       clock (CLOCK_RATE), which stops at every faceoff, penalty and goal.

       Which entry may set the clock matters more than the pace. A goal or a
       penalty is posted within seconds of the moment it is stamped with, so
       it is a true anchor: at the instant it arrives the arena clock shows
       its stamp. A comment is stamped with the moment it describes but is
       written minutes later; taken as an anchor it drags the clock back by
       exactly that delay, every time. Watched live, "TOOR für unsere Adler!"
       arrived stamped 7:31 while the arena already read about 9:50. So only
       goals and penalties re-anchor, and a comment may only push the clock
       forward, never back. */
    const game = this._game();
    const live = Boolean(game && game.mode === 'live' && (attrs.running || pause));
    const factor = this._clockRate();
    this._syncAnchor(attrs, state, live, factor);

    if (pause && pause.phase === 'drop' && (!this._anchor || this._anchor.wall < pause.till)) {
      this._anchor = {
        game: pause.period * PERIOD_SECONDS,
        wall: pause.till,
        key: `drop|${pause.till}`,
        holdUntil: 0,
      };
    }

    let elapsedTotal = Number(elapsedAtUpdate);
    if (live && this._anchor) {
      elapsedTotal = Math.max(elapsedTotal, this._carried(now, factor));
    }

    const elapsedInPeriod = Math.max(0, Math.min(
      PERIOD_SECONDS,
      elapsedTotal - (period ? (period - 1) * PERIOD_SECONDS : 0),
    ));

    return {
      period,
      elapsedInPeriod,
      elapsedTotal,
      remaining: PERIOD_SECONDS - elapsedInPeriod,
      source: attrs.source,
      pause: null,
    };
  }

  /* ── Break ───────────────────────────────────────── */

  /* "2026-10-07 18:21:59 +0000" to epoch milliseconds, or null. */
  _parseTill(text) {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(Z|[+-]\d{2}:?\d{2})?$/
      .exec(String(text || '').trim());
    if (!match) {
      return null;
    }
    let zone = match[3] || 'Z';
    if (/^[+-]\d{4}$/.test(zone)) {
      zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    }
    const parsed = Date.parse(`${match[1]}T${match[2]}${zone}`);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /* The club posts a Countdown entry at the end of a period: the title of the
     break and the absolute time it ends. The card reads it straight from the
     club's ticker (open to browsers, and a few seconds ahead of the sensor),
     and from the sensor as well, the newest end time winning. */
  _pollTicker() {
    const game = this._game();
    if (!game || game.mode !== 'live' || this._polling) {
      return;
    }
    const now = Date.now();
    if (now - this._lastPoll < TICKER_POLL_MS - 500) {
      return;
    }
    this._lastPoll = now;
    this._polling = true;

    fetch(ADLER_TICKER_URL, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const list = Array.isArray(payload)
          ? payload
          : ((payload && (payload.tickerevents || payload.live)) || []);
        let newest = null;
        list.forEach((entry) => {
          if (entry && entry.type === 'Countdown'
              && (!newest || Number(entry.id) > Number(newest.id))) {
            newest = entry;
          }
        });
        const till = newest ? this._parseTill(newest.countdownTill) : null;
        const period = newest ? Number(newest.period) || 0 : 0;
        this._pause = till !== null && period >= 1
          ? { till, title: String(newest.countdownTitle || ''), period }
          : null;
        this._paintVolatile();
      })
      .catch(() => {})
      .then(() => {
        this._polling = false;
      });
  }

  /* 'break' until the countdown ends, 'drop' for a short window after it
     (the puck is down, the feed still says "break"), else null. */
  _pauseState(now) {
    const game = this._game();
    if (!game || game.mode !== 'live') {
      return null;
    }

    let best = this._pause;
    const clockState = this._state('entity_clock');
    const events = (clockState && clockState.attributes && clockState.attributes.ticker_events) || [];
    events.forEach((event) => {
      if (!event || event.type !== 'Countdown' || !event.countdown_till) {
        return;
      }
      const till = this._parseTill(event.countdown_till);
      const period = Number(event.period) || 0;
      if (till === null || period < 1) {
        return;
      }
      if (!best || till > best.till) {
        best = { till, title: String(event.countdown_title || ''), period };
      }
    });

    if (!best) {
      return null;
    }

    const delta = (best.till - now) / 1000;
    if (delta > 0) {
      return { ...best, phase: 'break', remaining: delta };
    }
    if (-delta <= DROP_WINDOW_SECONDS) {
      return { ...best, phase: 'drop', remaining: 0 };
    }
    return null;
  }

  _pauseKeyOf(clock) {
    if (!clock) {
      return '';
    }
    return [clock.pause ? (clock.pause.title || 'pause') : '', clock.period].join('|');
  }

  _clockRate() {
    const rate = Number(this._config.clock_rate);
    return Number.isFinite(rate) && rate > 0 ? rate : CLOCK_RATE;
  }

  _eventSeconds(event) {
    const period = Number(event.period) || 0;
    if (period < 1) {
      return null;
    }
    return (period - 1) * PERIOD_SECONDS + (Number(event.minute) || 0) * 60 + (Number(event.second) || 0);
  }

  _syncAnchor(attrs, state, live, factor) {
    if (!live) {
      this._anchor = null;
      return;
    }

    let newest = null;
    (attrs.ticker_events || []).forEach((event) => {
      const seconds = this._eventSeconds(event);
      if (seconds !== null && (!newest || seconds >= newest.seconds)) {
        newest = { seconds, event };
      }
    });
    if (!newest) {
      return;
    }

    const key = [newest.event.type, newest.event.period, newest.event.minute, newest.event.second, newest.event.headline].join('|');
    if (this._anchor && this._anchor.key === key) {
      return;
    }

    const prompt = newest.event.type === 'Goal' || newest.event.type === 'Penalty';
    const now = Date.now();

    if (!this._anchor) {
      // First sight: the state's own receipt time is the best wall clock we
      // have for when this entry arrived.
      const received = state.last_updated ? new Date(state.last_updated).getTime() : now;
      this._anchor = { game: newest.seconds, wall: received, key };
      return;
    }

    // A video review is announced as a comment and stops the clock for a
    // long time. Watched live, the arena read 3:33 left while the feed sat
    // at "Videobeweis", so the comment is taken as a stoppage of its own.
    // Its stamp is not trusted to set the clock back, only to hold it.
    const review = newest.event.type === 'Comment'
      && /video/i.test(`${newest.event.headline || ''} ${newest.event.text || ''}`);
    const carried = this._carried(now, factor);

    if (prompt) {
      // A goal or a penalty stops the arena clock; the hold keeps the card
      // clock still for the rest of that stoppage.
      this._anchor = {
        game: newest.seconds,
        wall: now,
        key,
        holdUntil: now + (HOLD_AFTER[newest.event.type] || 0) * 1000,
      };
    } else if (review) {
      this._anchor = {
        game: Math.max(carried, newest.seconds),
        wall: now,
        key,
        holdUntil: now + HOLD_AFTER.Review * 1000,
      };
    } else if (newest.seconds > carried) {
      this._anchor = { game: newest.seconds, wall: now, key, holdUntil: 0 };
    } else {
      this._anchor.key = key;
    }
  }

  /* Game seconds the anchor has carried to `now`: real time since the
     anchor, less any hold still running, at the running pace. */
  _carried(now, factor) {
    const resume = Math.max(this._anchor.wall, this._anchor.holdUntil || 0);
    const running = Math.max(0, now - resume) / 1000;
    return this._anchor.game + running * factor;
  }

  _holding(now) {
    return Boolean(this._anchor && this._anchor.holdUntil && this._anchor.holdUntil > now);
  }

  /* Tenths need a faster tick, but only in the closing minute. Outside that
     window a second is plenty, and the text is only rewritten when it
     actually changed. */
  _startTicking() {
    const game = this._game();
    const clock = this._clock();
    const live = game && game.mode === 'live';
    const closing = live && clock && clock.remaining !== null && !clock.pause
      && clock.remaining < TENTHS_BELOW_SECONDS;
    const wanted = closing ? 100 : 1000;

    if (this._tickHandle && this._tickRate === wanted) {
      return;
    }

    this._stopTicking();
    this._tickRate = wanted;
    this._tickHandle = window.setInterval(() => {
      const current = this._game();
      if ((current && (current.mode === 'live' || current.mode === 'next')) || this._goalOverlay) {
        this._paintVolatile();
      }
      this._pollTicker();
      this._startTicking();
    }, wanted);
  }

  _stopTicking() {
    if (this._tickHandle) {
      window.clearInterval(this._tickHandle);
      this._tickHandle = null;
      this._tickRate = 0;
    }
  }

  _write(node, text) {
    if (node && node.textContent !== text) {
      node.textContent = text;
    }
  }

  _paintVolatile() {
    const game = this._game();
    const clockNode = this.querySelector('[data-role="clock"]');
    if (clockNode) {
      const clock = this._clock();
      if (clock && clock.remaining !== null) {
        const inBreak = Boolean(clock.pause);
        this._write(clockNode, inBreak ? formatBreak(clock.remaining) : formatClock(clock.remaining));
        clockNode.classList.toggle('tenths', !inBreak && clock.remaining < TENTHS_BELOW_SECONDS);
      }

      // Entering or leaving the break changes the whole face, not just text.
      const pauseKey = this._pauseKeyOf(clock);
      if (this._pauseKey !== undefined && this._pauseKey !== pauseKey) {
        this._pauseKey = pauseKey;
        this._signature = '';
        this._render();
        return;
      }
      this._pauseKey = pauseKey;
      // The hold after a goal or penalty ends on a timer, so the dot has to
      // flip here, between full renders.
      const dot = this.querySelector('.clock-dot');
      if (dot && game) {
        const state = this._dotState(game, clock);
        dot.classList.toggle('running', state === 'running');
        dot.classList.toggle('stopped', state === 'stopped');
      }
    }

    // A scorer leaves the screen on a timer too; that needs a full render.
    if (game) {
      const shown = this._lastGoalShown(game.state.attributes || {});
      if (this._lastGoalKnown !== undefined && this._lastGoalKnown !== shown) {
        this._lastGoalKnown = shown;
        this._signature = '';
        this._render();
        return;
      }
      this._lastGoalKnown = shown;
      const picture = this._screenPicture(game);
      const key = picture ? picture.url : '';
      if (this._pictureKey !== undefined && this._pictureKey !== key) {
        this._pictureKey = key;
        this._signature = '';
        this._render();
        return;
      }
      this._pictureKey = key;
    }

    this.querySelectorAll('[data-countdown]').forEach((node) => {
      this._write(node, this._countdown(node.getAttribute('data-countdown')) || '');
    });

    const boxes = this.querySelectorAll('[data-role="penalties"]');
    if (boxes.length) {
      const active = this._activePenalties();
      boxes.forEach((node) => {
        const own = node.getAttribute('data-side') === 'adler';
        node.innerHTML = this._renderPenalties(active.filter((entry) => entry.isAdler === own));
      });
    }
  }

  _countdown(iso) {
    if (!iso) {
      return null;
    }
    const target = new Date(iso).getTime();
    if (Number.isNaN(target)) {
      return null;
    }
    let delta = Math.floor((target - Date.now()) / 1000);
    if (delta <= 0) {
      return 'JETZT';
    }
    const days = Math.floor(delta / 86400);
    delta -= days * 86400;
    const hours = Math.floor(delta / 3600);
    delta -= hours * 3600;
    const minutes = Math.floor(delta / 60);
    const seconds = delta - minutes * 60;

    if (days > 0) {
      return `${days}T ${pad(hours)}:${pad(minutes)}`;
    }
    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    // Inside the last hour the cube counts the kickoff down on the game
    // clock itself, in plain MM:SS ("28:19").
    return `${pad(minutes)}:${pad(seconds)}`;
  }

  /* ── Penalties ───────────────────────────────────── */

  _activePenalties() {
    const game = this._game();
    if (!game || game.mode !== 'live') {
      return [];
    }

    const clock = this._clock();
    if (!clock || clock.elapsedTotal === null || clock.elapsedTotal === undefined || !clock.period) {
      return [];
    }

    /* Absolute game seconds, so a penalty runs on across the break into the
       next period and stands still while the break lasts. */
    const penalties = (game.state.attributes || {}).penalties || [];
    const active = [];

    penalties.forEach((penalty) => {
      const penaltyPeriod = Number(penalty.period) || 0;
      const offset = parseClockToSeconds(penalty.time);
      if (penaltyPeriod < 1 || offset === null) {
        return;
      }
      const start = (penaltyPeriod - 1) * PERIOD_SECONDS + offset;
      const end = start + (PENALTY_MINUTES[penalty.minutes] || 2) * 60;
      if (clock.elapsedTotal < start || clock.elapsedTotal >= end) {
        return;
      }
      active.push({
        jersey: penalty.player_jersey,
        isAdler: Boolean(penalty.is_adler),
        remaining: end - clock.elapsedTotal,
      });
    });

    return active.sort((a, b) => a.remaining - b.remaining);
  }

  /* Plain text, the way the board writes it: "#75 - 0:15". */
  _renderPenalties(entries) {
    if (!entries.length) {
      return '';
    }
    return entries
      .slice(0, 2)
      .map((entry) => `
        <span class="pen">
          #${escapeHtml(entry.jersey || '?')} - ${formatPenalty(entry.remaining)}
        </span>`)
      .join('');
  }

  /* ── Goal takeover ───────────────────────────────── */

  _detectNewGoal() {
    const game = this._game();
    if (!game || game.mode !== 'live') {
      this._knownGoalCount = null;
      this._goalOverlay = null;
      return;
    }

    const goals = ((game.state.attributes || {}).goals || []).filter((g) => g.is_adler_goal);

    if (this._knownGoalCount === null) {
      this._knownGoalCount = goals.length;
      return;
    }

    if (goals.length > this._knownGoalCount) {
      this._knownGoalCount = goals.length;
      this._goalOverlay = goals[goals.length - 1];
      this._goalPhase = 1;
      window.setTimeout(() => { this._goalPhase = 2; this._signature = ''; this._render(); }, 2600);
      window.setTimeout(() => {
        this._goalOverlay = null;
        this._goalPhase = 0;
        this._signature = '';
        this._render();
      }, 9000);
    }
  }

  /* ── Render ──────────────────────────────────────── */

  _render() {
    const game = this._game();
    const signature = this._makeSignature(game);
    if (signature === this._signature) {
      this._paintVolatile();
      return;
    }
    this._signature = signature;

    const theme = this._theme(game);
    const fill = this._config.full_height ? 'fill' : '';

    this.innerHTML = `
      <ha-card class="${fill}" style="--am-base:${theme.base};--am-accent:${theme.accent};--am-visual:${theme.visual}">
        <style>${this._styles()}</style>
        <div class="cube">
          ${this._renderRing(game, 'top')}
          <div class="frame">
            ${this._renderFace(game)}
            ${this._renderScreen(game)}
            ${this._renderFace(game)}
          </div>
          ${game ? this._renderBoard(game) : this._renderStandby()}
          ${this._renderRing(game, 'bottom')}
          ${this._goalOverlay ? this._renderGoalTakeover() : ''}
        </div>
        ${this._showDrawer() ? this._renderDrawer(game) : ''}
      </ha-card>`;

    this.querySelectorAll('[data-panel]').forEach((node) => {
      node.addEventListener('click', () => {
        const panel = node.getAttribute('data-panel');
        this._openPanel = this._openPanel === panel ? null : panel;
        this._signature = '';
        this._render();
      });
    });

    this._paintVolatile();
  }

  _showDrawer() {
    if (this._config.show_details !== undefined) {
      return Boolean(this._config.show_details);
    }
    return !this._config.full_height;
  }

  _makeSignature(game) {
    if (!game) {
      return 'standby';
    }
    const attrs = game.state.attributes || {};
    const stats = this._stats();
    const clock = this._clock() || {};
    return [
      game.mode, attrs.game_id, attrs.score_home, attrs.score_away,
      (attrs.goals || []).length, (attrs.penalties || []).length,
      stats.shots_adler, stats.shots_opponent, clock.period, this._pauseKeyOf(clock),
      this._openPanel, this._goalPhase, this._lastGoalShown(attrs),
      this._config.full_height, this._config.show_details,
    ].join('|');
  }

  _theme(game) {
    const attrs = game ? game.state.attributes || {} : {};
    const competition = attrs.competition || 'DEL';
    const base = cssColor(attrs.league_color, FALLBACK_COLORS[competition] || '#00264d');
    const url = attrs.league_background || FALLBACK_BACKGROUNDS[competition];
    const accent = competition === 'CHL' ? '#ff005a' : '#e50026';
    return {
      base,
      accent,
      competition,
      visual: url ? `url('${encodeURI(url)}')` : 'none',
    };
  }

  /* The LED rings around the hall carry the competition's wordmark. The CHL
     one is on the photographs ("CHL.HOCKEY"); the league one is the league's
     sponsored name and has not been photographed, so it is an assumption. */
  _renderRing(game, position) {
    const attrs = game ? game.state.attributes || {} : {};
    const competition = attrs.competition || 'DEL';
    const logo = attrs.competition_logo;
    const clock = game && game.mode === 'live' ? this._clock() : null;
    const breakWord = clock && clock.pause ? BREAK_RING[competition] : null;
    let item;
    if (position === 'bottom' && breakWord) {
      item = `<span>${escapeHtml(breakWord)}</span>`;
    } else if (position === 'bottom' && attrs.home_team && attrs.away_team) {
      // The lower band runs the pairing while the upper keeps the
      // competition, as photographed during play.
      item = `<span>${escapeHtml(attrs.home_team.toUpperCase())}</span>`
        + `<span class="ring-v">V</span>`
        + `<span>${escapeHtml(attrs.away_team.toUpperCase())}</span>`;
    } else {
      const word = RING_WORDS[competition] || attrs.competition_title || competition;
      item = `${logo ? `<img src="${escapeHtml(logo)}" alt=""/>` : ''}<span>${escapeHtml(word)}</span>`;
    }
    const run = new Array(8).fill(item).join('');
    return `
      <div class="ring ${position}">
        <div class="ring-track">${run}${run}</div>
      </div>`;
  }

  /* A side face of the cube reads the pairing top to bottom: home crest,
     "V", away crest. */
  _renderFace(game) {
    const attrs = game ? game.state.attributes || {} : {};
    const home = attrs.home_logo || ADLER_CREST;
    const away = attrs.away_logo;
    return `
      <div class="face">
        <img class="face-crest" src="${escapeHtml(home)}" alt="" onerror="this.remove()"/>
        <span class="face-v">V</span>
        ${away ? `<img class="face-crest" src="${escapeHtml(away)}" alt="" onerror="this.remove()"/>` : ''}
      </div>`;
  }

  /* The screen is where the cube shows video. Without video it shows the
     competition's key visual with the competition mark in the middle, and
     that is what the card shows before a game. During and after a game the
     last Adler scorer takes the screen, else the squad photo. */
  _renderScreen(game) {
    const attrs = game ? game.state.attributes || {} : {};
    const picture = this._screenPicture(game);
    const meta = [
      attrs.competition_title || attrs.competition,
      attrs.matchday ? `${attrs.matchday}. SPIELTAG` : null,
      (attrs.arena || '').trim().toUpperCase() || null,
    ].filter(Boolean).join('  ·  ');

    return `
      <div class="screen">
        ${picture
          ? `<img class="screen-img" src="${escapeHtml(picture.url)}" alt="" onerror="this.remove()"/>`
          : ''}
        <div class="screen-scrim ${picture ? 'photo' : 'visual'}"></div>
        ${!picture && attrs.competition_logo
          ? `<img class="screen-mark" src="${escapeHtml(attrs.competition_logo)}" alt="" onerror="this.remove()"/>`
          : ''}
        <div class="screen-caption">
          ${picture ? `<span class="caption-main">${escapeHtml(picture.title)}</span>` : ''}
          ${picture && picture.sub ? `<span class="caption-sub">${escapeHtml(picture.sub)}</span>` : ''}
          ${meta ? `<span class="caption-meta">${escapeHtml(meta)}</span>` : ''}
        </div>
      </div>`;
  }

  /* During play the club's own live feed is the picture: its photographer
     posts match photographs into the ticker as comments, a goal entry
     carries the scorer's portrait, a penalty the player. The newest of
     those takes the screen; older builds of the integration do not pass the
     fields through, and the card then falls back to the goal list and the
     squad photo below. */
  _tickerPicture(game) {
    if (!game || game.mode !== 'live') {
      return null;
    }
    const clockState = this._state('entity_clock');
    const events = clockState && clockState.attributes ? clockState.attributes.ticker_events || [] : [];
    const total = this._elapsedTotal();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const key = [event.type, event.period, event.minute, event.second].join('|');
      if (this._stale(event.type, this._eventSeconds(event), total) || !this._fresh(event.type, key)) {
        continue;
      }
      const score = event.score_home !== undefined && event.score_home !== null
        ? `${event.score_home}:${event.score_away}` : null;
      // Portraits are capped at 600: sharp on the screen, under half a
      // megabyte, where 1000 already weighs 1.2 MB per goal.
      if (event.type === 'Goal' && (event.photo || event.image)) {
        return {
          url: scaleImage(event.photo || event.image, 600),
          title: `TOR  ${event.player || event.team || ''}`.trim(),
          sub: [score, event.goal_type, `${event.minute}:${pad(event.second)}`].filter(Boolean).join('  ·  '),
        };
      }
      if (event.type === 'Comment' && event.image) {
        return {
          url: scaleImage(event.image, 1400),
          title: event.headline || '',
          sub: event.text ? event.text.slice(0, 140) : null,
        };
      }
      if (event.type === 'Penalty' && event.photo) {
        return {
          url: scaleImage(event.photo, 600),
          title: `STRAFE  ${event.player || ''}`.trim(),
          sub: [event.infraction, event.minutes, event.team].filter(Boolean).join('  ·  '),
        };
      }
    }
    return null;
  }

  /* First-sight times per game, kept in the browser so a reload or a second
     card does not restart the display window of a picture that has been up
     for minutes. */
  _seenMap() {
    const game = this._game();
    return this._seenFor(game && game.state.attributes ? game.state.attributes.game_id : null);
  }

  _seenFor(id) {
    if (this._seenGame === id) {
      return this._seen;
    }
    this._seenGame = id;
    this._seen = {};
    if (id === null || id === undefined) {
      return this._seen;
    }
    try {
      const stored = JSON.parse(localStorage.getItem(`${SEEN_STORAGE}${id}`) || 'null');
      if (stored && typeof stored.seen === 'object') {
        this._seen = stored.seen;
      }
    } catch (error) {
      this._seen = {};
    }
    return this._seen;
  }

  _saveSeen() {
    if (this._seenGame === null || this._seenGame === undefined) {
      return;
    }
    try {
      const now = Date.now();
      localStorage.setItem(
        `${SEEN_STORAGE}${this._seenGame}`,
        JSON.stringify({ saved: now, seen: this._seen }),
      );
      if (this._pruned) {
        return;
      }
      this._pruned = true;
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const name = localStorage.key(index);
        if (!name || !name.startsWith(SEEN_STORAGE) || name === `${SEEN_STORAGE}${this._seenGame}`) {
          continue;
        }
        let saved = 0;
        try {
          saved = Number(JSON.parse(localStorage.getItem(name)).saved) || 0;
        } catch (error) {
          saved = 0;
        }
        if (now - saved > SEEN_KEEP_MS) {
          localStorage.removeItem(name);
        }
      }
    } catch (error) {
      // Storage blocked or full: the window then simply restarts per load.
    }
  }

  _noteLive(id) {
    const seen = this._seenFor(id);
    if (!seen.Live) {
      seen.Live = Date.now();
      this._saveSeen();
    }
  }

  /* The moment the match ended. A card that watched it go live stamps the
     final; a card that loads later assumes the usual length after the start,
     so a reload does not restart the hour. */
  _endedAt(attrs) {
    const seen = this._seenFor(attrs.game_id);
    if (!seen.End) {
      const started = Date.parse(attrs.match_start_iso || '');
      if (seen.Live) {
        seen.End = Date.now();
      } else {
        seen.End = Number.isNaN(started) ? Date.now() : started + ASSUMED_GAME_MS;
      }
      this._saveSeen();
    }
    return seen.End;
  }

  _finalShown(attrs) {
    return Date.now() < this._endedAt(attrs) + FINAL_SHOW_MS;
  }

  /* Seconds since the card first saw a given picture. A scorer leaves the
     screen again after a while, the way the cube returns from the replay to
     the game; without this the last scorer would stay up for the rest of
     the match. */
  _age(key) {
    const seen = this._seenMap();
    const now = Date.now();
    if (!seen[key]) {
      seen[key] = now;
      this._saveSeen();
    }
    return (now - seen[key]) / 1000;
  }

  _fresh(kind, key) {
    return this._age(`${kind}|${key}`) < (PICTURE_SECONDS[kind] || 0);
  }

  /* Game seconds elapsed since the start of the match, or null when the
     clock is unknown. A picture whose moment lies further back than its
     limit is dropped even for a card that sees it for the first time. */
  _elapsedTotal() {
    const clock = this._clock();
    return clock && clock.elapsedTotal !== undefined ? clock.elapsedTotal : null;
  }

  _stale(kind, seconds, total) {
    const limit = STALE_GAME_SECONDS[kind];
    if (limit === undefined || seconds === null || seconds === undefined || total === null || total === undefined) {
      return false;
    }
    return total - seconds > limit;
  }

  _goalSeconds(goal) {
    const period = Number(goal.period) || 0;
    const offset = parseClockToSeconds(goal.time);
    if (period < 1 || offset === null) {
      return null;
    }
    return (period - 1) * PERIOD_SECONDS + offset;
  }

  _screenPicture(game) {
    if (!game || game.mode === 'next') {
      return null;
    }
    const clock = game.mode === 'live' ? this._clock() : null;
    const inBreak = Boolean(clock && clock.pause);
    const live = inBreak ? null : this._tickerPicture(game);
    if (live) {
      return live;
    }
    const attrs = game.state.attributes || {};
    const total = clock && clock.elapsedTotal !== undefined ? clock.elapsedTotal : null;
    const scored = inBreak ? [] : (attrs.goals || []).filter((goal) => goal.is_adler_goal && goal.scorer_photo);
    if (scored.length) {
      const goal = scored[scored.length - 1];
      const key = [goal.period, goal.time, goal.scorer].join('|');
      if (game.mode === 'final'
        || (!this._stale('Goal', this._goalSeconds(goal), total) && this._fresh('Goal', key))) {
        return {
          url: scaleImage(goal.scorer_photo, 1000),
          title: goal.scorer,
          sub: [`${goal.score_home ?? ''}:${goal.score_away ?? ''}`, goal.time].filter(Boolean).join('  ·  '),
        };
      }
    }
    const roster = this._state('entity_roster');
    const teamPhoto = roster && roster.attributes ? roster.attributes.team_photo : null;
    if (teamPhoto) {
      return { url: scaleImage(teamPhoto, 1400), title: 'ADLER MANNHEIM', sub: null };
    }
    return null;
  }

  _renderStandby() {
    return `
      <div class="standby">
        <div class="standby-word">ADLER MANNHEIM</div>
        <div class="standby-sub">keine Spieldaten</div>
      </div>`;
  }

  _renderBoard(game) {
    const attrs = game.state.attributes || {};
    const stats = this._stats();
    const clock = this._clock();
    const isLive = game.mode === 'live';
    const isNext = game.mode === 'next';
    const adlerHome = attrs.is_home === true;

    const homeShort = (attrs.home_team_short || (attrs.home_team || '???').slice(0, 3)).toUpperCase();
    const awayShort = (attrs.away_team_short || (attrs.away_team || '???').slice(0, 3)).toUpperCase();

    let state = '';
    if (game.mode === 'final') {
      state = 'ENDSTAND';
    } else if (isNext) {
      state = attrs.is_home ? 'HEIMSPIEL' : 'AUSWÄRTSSPIEL';
    } else if (isLive && clock && clock.pause) {
      state = (clock.pause.title || `${clock.pause.period}. Pause`).toUpperCase();
    } else if (attrs.shootout) {
      state = 'PENALTYSCHIESSEN';
    } else if (attrs.overtime) {
      state = 'VERLÄNGERUNG';
    }

    return `
      <div class="board">
        <span class="board-mark">
          ${attrs.competition_logo
            ? `<img src="${escapeHtml(attrs.competition_logo)}" alt="" onerror="this.remove()"/>`
            : ''}
        </span>

        <div class="pen-zone left" data-role="penalties" data-side="${adlerHome ? 'adler' : 'opponent'}"></div>

        <div class="core">
          <div class="team">
            <span class="team-code">${escapeHtml(homeShort)}</span>
            <span class="team-score">${escapeHtml(attrs.score_home ?? 0)}</span>
          </div>

          <div class="middle">
            <span class="clock-dot ${this._dotState(game, clock)}"></span>
            ${isNext
              ? `<span class="clock" data-countdown="${escapeHtml(attrs.match_start_iso || '')}"></span>`
              : `<span class="clock ${isLive ? '' : 'idle'}" data-role="clock">${isLive ? '--:--' : escapeHtml(this._finalLabel(attrs))}</span>`}
            ${this._renderClubStripe(game, clock)}
          </div>

          <div class="team">
            <span class="team-code">${escapeHtml(awayShort)}</span>
            <span class="team-score">${escapeHtml(attrs.score_away ?? 0)}</span>
          </div>
        </div>

        <div class="pen-zone right" data-role="penalties" data-side="${adlerHome ? 'opponent' : 'adler'}"></div>

        <span class="board-mark">
          ${attrs.competition_logo
            ? `<img src="${escapeHtml(attrs.competition_logo)}" alt="" onerror="this.remove()"/>`
            : ''}
        </span>
      </div>

      ${state || isNext ? `<div class="state">${escapeHtml(state)}${isNext ? `<span class="state-time">${escapeHtml(game.state.state || '')}</span>` : ''}</div>` : ''}

      <div class="foot">
        ${this._renderPeriodScores(attrs)}
        ${this._renderShots(attrs, stats)}
      </div>

      ${isLive && !(clock && clock.pause) ? this._renderLastGoal(attrs) : ''}`;
  }

  /* The dot above the clock reports the clock, not the game: green while it
     runs, red once it has stopped, and seen live it goes red at every
     interruption. The API carries no clock-state field, only event
     timestamps, so a stoppage at a faceoff or penalty is invisible here.
     What the card can tell apart is a period end and no game at all; in
     between it stays green. */
  _dotState(game, clock) {
    if (game.mode === 'next') {
      return 'running';
    }
    if (game.mode === 'live') {
      if (clock && clock.pause) {
        return 'stopped';
      }
      if (this._holding(Date.now())) {
        return 'stopped';
      }
      return clock && clock.remaining > 0 ? 'running' : 'stopped';
    }
    return 'stopped';
  }

  _finalLabel(attrs) {
    if (attrs.shootout) {
      return 'P';
    }
    if (attrs.overtime) {
      return 'V';
    }
    return '60:00';
  }

  /* Three bars in the club colours under the clock. They fill up with the
     game: blue alone in the first period, blue and white in the second, all
     three from the third period on. Lit bars glow, the rest stay dim. */
  _renderClubStripe(game, clock) {
    const current = game.mode === 'live' && clock && clock.period ? clock.period : 0;
    const bars = [['blue', 1], ['white', 2], ['red', 3]];
    return `
      <span class="stripe">
        ${bars.map(([colour, period]) => `
          <span class="stripe-bar ${colour} ${period <= current ? 'lit' : ''}"></span>`).join('')}
      </span>`;
  }

  _renderPeriodScores(attrs) {
    const cells = [];
    for (let index = 1; index <= 3; index += 1) {
      if (attrs[`period_${index}`]) {
        cells.push({ label: `${index}.`, value: attrs[`period_${index}`] });
      }
    }
    if (attrs.overtime) {
      cells.push({ label: 'V', value: attrs.overtime });
    }
    if (attrs.shootout) {
      cells.push({ label: 'P', value: attrs.shootout });
    }
    if (!cells.length) {
      return '<span></span>';
    }
    return `
      <span class="periods">
        ${cells.map((cell) => `
          <span class="period-cell">
            <b>${escapeHtml(cell.label)}</b>${escapeHtml(cell.value)}
          </span>`).join('')}
      </span>`;
  }

  _renderShots(attrs, stats) {
    if (stats.shots_adler === undefined) {
      return '<span></span>';
    }
    const adlerHome = attrs.is_home === true;
    const home = adlerHome ? stats.shots_adler : stats.shots_opponent;
    const away = adlerHome ? stats.shots_opponent : stats.shots_adler;
    return `
      <span class="shots">
        <i>SCHÜSSE</i>${escapeHtml(home ?? 0)} : ${escapeHtml(away ?? 0)}
      </span>`;
  }

  /* The band under the board names the latest goal for a short while, for
     either side, and then gives the space back. */
  _lastGoalShown(attrs) {
    const goals = attrs.goals || [];
    const goal = goals[goals.length - 1];
    if (!goal || !goal.scorer) {
      return false;
    }
    const key = [goal.period, goal.time, goal.scorer, goal.is_adler_goal].join('|');
    if (this._stale('LastGoal', this._goalSeconds(goal), this._elapsedTotal())) {
      return false;
    }
    return this._fresh('LastGoal', key);
  }

  _renderLastGoal(attrs) {
    if (!this._lastGoalShown(attrs)) {
      return '';
    }
    const goals = attrs.goals || [];
    const goal = goals[goals.length - 1];
    const assists = [goal.assist1, goal.assist2].filter(Boolean).join(', ');
    return `
      <div class="lastgoal ${goal.is_adler_goal ? 'own' : 'opp'}">
        <span class="lastgoal-tag">${goal.is_adler_goal ? 'TOR ADLER' : 'TOR GEGNER'}</span>
        <span class="lastgoal-name">${escapeHtml(goal.scorer)}</span>
        ${assists ? `<span class="lastgoal-assist">${escapeHtml(assists)}</span>` : ''}
        <span class="lastgoal-time">${escapeHtml(goal.time || '')}</span>
      </div>`;
  }

  _renderGoalTakeover() {
    const goal = this._goalOverlay;
    const assists = [goal.assist1, goal.assist2].filter(Boolean).join('  ·  ');
    if (this._goalPhase === 1) {
      return '<div class="takeover shout"><div class="takeover-word">TOR</div></div>';
    }
    return `
      <div class="takeover detail">
        ${goal.scorer_photo
          ? `<img class="takeover-photo" src="${escapeHtml(goal.scorer_photo)}" alt="" onerror="this.remove()"/>`
          : ''}
        <div class="takeover-stack">
          ${goal.scorer_jersey ? `<div class="takeover-jersey">${escapeHtml(goal.scorer_jersey)}</div>` : ''}
          <div class="takeover-name">${escapeHtml(goal.scorer || '')}</div>
          ${assists ? `<div class="takeover-assist">VORLAGE ${escapeHtml(assists)}</div>` : ''}
          <div class="takeover-meta">
            ${escapeHtml(goal.score_home ?? '')}:${escapeHtml(goal.score_away ?? '')}
            ${goal.time ? ` · ${escapeHtml(goal.time)}` : ''}
            ${goal.type ? ` · ${escapeHtml(GOAL_TYPE_LABELS[goal.type] || goal.type)}` : ''}
          </div>
        </div>
      </div>`;
  }

  /* ── Drawer ──────────────────────────────────────── */

  _renderDrawer(game) {
    const next = this._state('entity_next');
    const last = this._state('entity_last');
    const stats = this._stats();
    const tiles = [];

    if (next && next.attributes.game_id) {
      tiles.push(`
        <button class="tile" data-panel="next">
          <span class="tile-label">NÄCHSTES SPIEL</span>
          <span class="tile-main">${escapeHtml(next.attributes.opponent || '?')}</span>
          <span class="tile-sub" data-countdown="${escapeHtml(next.attributes.match_start_iso || '')}"></span>
        </button>`);
    }
    if (last && last.attributes.game_id) {
      tiles.push(`
        <button class="tile" data-panel="last">
          <span class="tile-label">LETZTES SPIEL</span>
          <span class="tile-main">${escapeHtml(last.attributes.score_home ?? 0)}:${escapeHtml(last.attributes.score_away ?? 0)}</span>
          <span class="tile-sub">${escapeHtml(last.attributes.opponent || '')}</span>
        </button>`);
    }
    if (stats.shots_adler !== undefined) {
      tiles.push(`
        <button class="tile" data-panel="stats">
          <span class="tile-label">STATISTIK</span>
          <span class="tile-main">${escapeHtml(stats.shots_adler ?? 0)}:${escapeHtml(stats.shots_opponent ?? 0)}</span>
          <span class="tile-sub">Schüsse · PP ${escapeHtml(stats.powerplay_adler || '0/0')}</span>
        </button>`);
    }

    if (!tiles.length) {
      return '';
    }

    let panel = '';
    if (this._openPanel === 'stats') {
      panel = this._renderStatsPanel(stats);
    } else if (this._openPanel === 'last' && last) {
      panel = this._renderTimeline(last.attributes);
    } else if (this._openPanel === 'next' && next) {
      panel = this._renderNextPanel(next.attributes);
    }

    return `<div class="drawer"><div class="tiles">${tiles.join('')}</div>${panel}</div>`;
  }

  _renderNextPanel(attrs) {
    const rows = [
      ['ANPFIFF', attrs.match_start],
      ['WETTBEWERB', attrs.competition_title || attrs.competition],
      ['SPIELTAG', attrs.matchday],
      ['ORT', (attrs.arena || '').trim() || (attrs.is_home ? 'SAP Arena' : 'Auswärts')],
      ['TABELLE', attrs.rank_adler ? `${attrs.rank_adler}. gegen ${attrs.rank_opponent || '?'}.` : null],
    ].filter((row) => row[1]);

    return `
      <div class="panel">
        <div class="panel-grid">
          ${rows.map(([key, value]) => `
            <div class="panel-item">
              <span class="panel-key">${escapeHtml(key)}</span>
              <span class="panel-val">${escapeHtml(value)}</span>
            </div>`).join('')}
        </div>
        ${attrs.link_ticketing
          ? `<a class="panel-link" href="${escapeHtml(attrs.link_ticketing)}" target="_blank" rel="noopener">TICKETS</a>`
          : ''}
      </div>`;
  }

  _renderStatsPanel(stats) {
    const rows = [
      ['SCHÜSSE AUFS TOR', stats.shots_adler, stats.shots_opponent],
      ['SCHÜSSE DANEBEN', stats.shots_missed_adler, stats.shots_missed_opponent],
      ['BULLY GEWONNEN %', stats.faceoff_pct_adler, stats.faceoff_pct_opponent],
      ['POWERPLAY', stats.powerplay_adler, stats.powerplay_opponent],
      ['STRAFMINUTEN', stats.pim_adler, stats.pim_opponent],
      ['PARADEN', stats.saves_adler, stats.saves_opponent],
    ];

    const referees = (stats.officials || [])
      .filter((official) => official.role && official.role.startsWith('referee'))
      .map((official) => official.name)
      .filter(Boolean);

    const meta = [
      (stats.arena || '').trim(),
      stats.attendance ? `${Number(stats.attendance).toLocaleString('de-DE')} Zuschauer` : null,
      referees.length ? `Schiedsrichter ${referees.join(', ')}` : null,
    ].filter(Boolean).join('  ·  ');

    return `
      <div class="panel">
        <div class="cmp-head"><span>ADLER</span><span>GEGNER</span></div>
        ${rows.map(([label, own, opponent]) => this._renderCompare(label, own, opponent)).join('')}
        ${meta ? `<div class="panel-meta">${escapeHtml(meta)}</div>` : ''}
      </div>`;
  }

  _renderCompare(label, own, opponent) {
    const ownNumber = Number(String(own).split('/')[0]) || 0;
    const opponentNumber = Number(String(opponent).split('/')[0]) || 0;
    const total = ownNumber + opponentNumber;
    const share = total ? Math.round((ownNumber / total) * 100) : 50;
    return `
      <div class="cmp">
        <span class="cmp-val own">${escapeHtml(own ?? '0')}</span>
        <span class="cmp-mid">
          <span class="cmp-label">${escapeHtml(label)}</span>
          <span class="cmp-track">
            <span class="cmp-fill own" style="width:${share}%"></span>
            <span class="cmp-fill opp" style="width:${100 - share}%"></span>
          </span>
        </span>
        <span class="cmp-val opp">${escapeHtml(opponent ?? '0')}</span>
      </div>`;
  }

  _renderTimeline(attrs) {
    const events = [];
    (attrs.goals || []).forEach((goal) => {
      events.push({
        kind: 'goal',
        period: goal.period || 0,
        seconds: parseClockToSeconds(goal.time) || 0,
        time: goal.time,
        own: goal.is_adler_goal,
        title: goal.scorer,
        sub: [goal.assist1, goal.assist2].filter(Boolean).join(', '),
        badge: goal.score_home !== undefined && goal.score_home !== null
          ? `${goal.score_home}:${goal.score_away}`
          : (GOAL_TYPE_LABELS[goal.type] || goal.type),
      });
    });
    (attrs.penalties || []).forEach((penalty) => {
      events.push({
        kind: 'penalty',
        period: penalty.period || 0,
        seconds: parseClockToSeconds(penalty.time) || 0,
        time: penalty.time,
        own: penalty.is_adler,
        title: penalty.player,
        sub: penalty.infraction,
        badge: penalty.minutes,
      });
    });

    if (!events.length) {
      return '<div class="panel"><div class="panel-meta">Keine Ereignisse</div></div>';
    }

    events.sort((a, b) => (a.period - b.period) || (a.seconds - b.seconds));

    const periods = new Map();
    events.forEach((event) => {
      if (!periods.has(event.period)) {
        periods.set(event.period, []);
      }
      periods.get(event.period).push(event);
    });

    const blocks = [...periods.entries()].map(([period, entries]) => `
      <div class="tl-block">
        <div class="tl-head">${period ? `${period}. DRITTEL` : 'SONSTIGE'}</div>
        ${entries.map((event) => `
          <div class="tl-row ${event.kind} ${event.own ? 'own' : 'opp'}">
            <span class="tl-time">${escapeHtml(event.time || '')}</span>
            <span class="tl-mark"></span>
            <span class="tl-body">
              <span class="tl-title">${escapeHtml(event.title || '')}</span>
              ${event.sub ? `<span class="tl-sub">${escapeHtml(event.sub)}</span>` : ''}
            </span>
            ${event.badge ? `<span class="tl-badge">${escapeHtml(event.badge)}</span>` : ''}
          </div>`).join('')}
      </div>`).join('');

    return `<div class="panel timeline">${blocks}</div>`;
  }

  /* ── Styles ──────────────────────────────────────── */

  _styles() {
    return `
      @font-face {
        font-family: 'AM Industry';
        src: url('${FONT_BASE}/Industry-BlackItalic.woff2') format('woff2');
        font-weight: 900;
        font-style: italic;
        font-display: swap;
      }
      @font-face {
        font-family: 'AM Industry Inc';
        src: url('${FONT_BASE}/IndustryInc-Base.woff2') format('woff2');
        font-weight: 400;
        font-display: swap;
      }
      @font-face {
        font-family: 'AM 72';
        src: url('${FONT_BASE}/72-Regular-full.woff2') format('woff2');
        font-weight: 400;
        font-display: swap;
      }
      @font-face {
        font-family: 'AM 72';
        src: url('${FONT_BASE}/72-Bold-full.woff2') format('woff2');
        font-weight: 700;
        font-display: swap;
      }

      :host { display: block; }
      ha-card {
        --am-board: #0d1013;
        --am-ink: #ffffff;
        --am-muted: rgba(255, 255, 255, 0.55);
        --am-line: rgba(255, 255, 255, 0.1);
        overflow: hidden;
        border: none;
        padding: 0;
        background: #05080b;
        color: var(--am-ink);
        font-family: 'AM 72', system-ui, sans-serif;
      }
      /* Full height: the screen grows, the strip stays pinned beneath it,
         the way the cube hangs. */
      ha-card.fill { min-height: calc(100vh - 56px); display: flex; flex-direction: column; }
      ha-card.fill .cube { flex: 1; }
      ha-card.fill .frame { flex: 1; }
      ha-card.fill .screen { aspect-ratio: auto; min-height: 220px; }

      .cube {
        position: relative;
        overflow: hidden;
        container-type: inline-size;
        display: flex;
        flex-direction: column;
        background: #05080b;
      }

      /* ── LED rings ───────────────────────────────── */
      /* The bands that run around the hall: competition colour, the
         competition's pattern multiplied in, mark and wordmark repeating. */
      .ring {
        overflow: hidden;
        white-space: nowrap;
        background-color: var(--am-accent);
        background-image: var(--am-visual);
        background-size: 60% auto;
        background-blend-mode: multiply;
      }
      .ring-track {
        display: inline-flex;
        align-items: center;
        gap: 2.6em;
        padding: 0.38em 0;
        animation: ring-scroll 48s linear infinite;
        will-change: transform;
      }
      .ring-track img { height: 1.15em; width: auto; filter: brightness(0) invert(1); }
      .ring-track span {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        letter-spacing: 0.14em;
        color: #fff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      }
      @keyframes ring-scroll { to { transform: translateX(-50%); } }

      /* ── Front: side faces and the screen ────────── */
      .frame {
        display: grid;
        grid-template-columns: auto 1fr auto;
        min-height: 0;
        background: var(--am-base);
      }
      .face {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.7em;
        background:
          linear-gradient(180deg, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.72)),
          var(--am-visual);
        background-size: cover;
        background-position: center;
      }
      .face:first-child { border-right: 1px solid rgba(255, 255, 255, 0.1); }
      .face:last-child { border-left: 1px solid rgba(255, 255, 255, 0.1); }
      .face-crest { width: auto; object-fit: contain; filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.6)); }
      .face-v {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        color: #fff;
        line-height: 1;
      }
      .screen {
        position: relative;
        overflow: hidden;
        display: grid;
        place-items: center;
        aspect-ratio: 16 / 7;
        background-color: var(--am-base);
        background-image: var(--am-visual);
        background-size: cover;
        background-position: center;
      }
      .screen-img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top center;
      }
      .screen-scrim { position: absolute; inset: 0; }
      .screen-scrim.photo {
        background: linear-gradient(180deg, rgba(0, 0, 0, 0) 40%, rgba(0, 0, 0, 0.88) 100%);
      }
      .screen-scrim.visual {
        background: radial-gradient(65% 65% at 50% 50%, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.3) 100%);
      }
      .screen-mark {
        position: relative;
        width: auto;
        filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.55));
      }
      .screen-caption {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        flex-direction: column;
        gap: 0.25em;
        padding: 1em 1.3em;
      }
      .caption-main {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        color: #fff;
        line-height: 1;
        text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
      }
      .caption-sub { color: rgba(255, 255, 255, 0.85); font-variant-numeric: tabular-nums; }
      .caption-meta {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        letter-spacing: 0.2em;
        color: rgba(255, 255, 255, 0.72);
        text-transform: uppercase;
      }

      /* ── The strip ───────────────────────────────── */
      /* Near black, set apart, with the numbers upright and white. */
      /* The strip stays this neutral dark on every competition: both
         photographs show the same tone, one at a league game and one at a
         Champions League game. Only the surround takes the competition
         colour. The competition mark sits at each far end. */
      /* The strip is the competition visual pushed almost to black, so the
         pattern only just shows through, as it does on the cube. */
      .board {
        position: relative;
        display: grid;
        grid-template-columns: auto 1fr auto 1fr auto;
        align-items: center;
        gap: 10px;
        padding: 14px 16px;
        background:
          linear-gradient(180deg, rgba(8, 9, 12, 0.9), rgba(8, 9, 12, 0.95)),
          var(--am-visual);
        background-color: var(--am-board);
        background-size: cover;
        background-position: center;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
      }
      .board-mark { display: flex; align-items: center; opacity: 0.5; }
      .board-mark img { width: auto; display: block; }
      .board-mark:empty { display: none; }
      .core {
        display: grid;
        grid-template-columns: auto auto auto;
        align-items: start;
        justify-items: center;
        gap: 16px;
      }
      .team { display: flex; flex-direction: column; align-items: center; }
      .team-code {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        letter-spacing: 0.22em;
        color: var(--am-muted);
        line-height: 1;
      }
      .team-score,
      .clock {
        font-family: 'AM Industry Inc', 'Arial Narrow', system-ui, sans-serif;
        font-weight: 400;
        color: var(--am-ink);
        line-height: 0.92;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.01em;
      }
      .middle { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .clock-dot { border-radius: 50%; }
      .clock-dot.running {
        background: #2fd45f;
        box-shadow: 0 0 10px rgba(47, 212, 95, 0.6);
      }
      .clock-dot.stopped {
        background: #e8333f;
        box-shadow: 0 0 10px rgba(232, 51, 63, 0.55);
      }
      .clock.idle { color: var(--am-muted); }
      .clock.tenths { letter-spacing: 0.02em; }
      /* One bar per period in the club's colours; the running period is lit,
         the rest sit dimmed. */
      .stripe { display: flex; gap: 4px; }
      .stripe-bar { border-radius: 99px; opacity: 0.26; transition: opacity 0.4s ease; }
      .stripe-bar.lit { opacity: 1; }
      .stripe-bar.blue { background: #0b5ca8; color: #0b5ca8; }
      .stripe-bar.white { background: #e9eef4; color: #e9eef4; }
      .stripe-bar.red { background: #d8232f; color: #d8232f; }
      .stripe-bar.lit { box-shadow: 0 0 8px currentColor; }
      .ring-v {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        margin: 0 0.4em;
      }

      /* Penalties read as plain text at the outer edges of the strip. */
      .pen-zone { display: flex; flex-direction: column; gap: 3px; min-height: 1px; }
      .pen-zone.left { align-items: flex-start; }
      .pen-zone.right { align-items: flex-end; }
      .pen {
        font-family: 'AM 72', system-ui, sans-serif;
        color: var(--am-ink);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        opacity: 0.92;
      }

      .state {
        display: flex;
        align-items: baseline;
        justify-content: center;
        gap: 10px;
        padding: 9px 14px 0;
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        letter-spacing: 0.2em;
        color: var(--am-muted);
        text-transform: uppercase;
      }
      .state-time { font-family: 'AM 72', sans-serif; letter-spacing: 0.04em; color: var(--am-ink); }

      .foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding: 10px 16px 12px;
      }
      .periods { display: flex; gap: 8px; flex-wrap: wrap; }
      .period-cell {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.82);
      }
      .period-cell b {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        font-weight: 400;
        letter-spacing: 0.12em;
        color: var(--am-muted);
      }
      .shots {
        display: inline-flex;
        align-items: baseline;
        gap: 8px;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.82);
      }
      .shots i {
        font-style: normal;
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        letter-spacing: 0.16em;
        color: var(--am-muted);
      }

      .lastgoal {
        display: flex;
        align-items: center;
        gap: 9px;
        flex-wrap: wrap;
        margin: 0 10px 12px;
        padding: 8px 12px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.05);
        border-left: 3px solid rgba(255, 255, 255, 0.3);
      }
      .lastgoal.own { border-left-color: var(--am-accent); }
      .lastgoal-tag {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        letter-spacing: 0.18em;
        color: var(--am-muted);
      }
      .lastgoal-name { font-weight: 700; }
      .lastgoal-assist { color: var(--am-muted); }
      .lastgoal-time {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
        color: var(--am-muted);
      }

      .standby { padding: 48px 0; text-align: center; }
      .standby-word {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        letter-spacing: 0.16em;
      }
      .standby-sub {
        margin-top: 7px;
        font-size: 11px;
        letter-spacing: 0.2em;
        color: var(--am-muted);
        text-transform: uppercase;
      }

      .takeover {
        position: absolute;
        inset: 0;
        z-index: 4;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at 50% 45%, var(--am-accent) 0%, rgba(5, 8, 11, 0.95) 72%);
        animation: fade 0.22s ease-out;
      }
      @keyframes fade { from { opacity: 0; } }
      .takeover-word {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        letter-spacing: 0.04em;
        animation: punch 0.62s cubic-bezier(.2,.8,.2,1) infinite alternate;
      }
      @keyframes punch { to { transform: scale(1.09); } }
      .takeover.detail { grid-auto-flow: column; gap: 18px; padding: 18px; }
      .takeover-photo {
        border-radius: 50%;
        object-fit: cover;
        border: 2px solid rgba(255, 255, 255, 0.85);
      }
      .takeover-stack { text-align: left; }
      .takeover-jersey {
        font-family: 'AM Industry Inc', sans-serif;
        line-height: 1;
        opacity: 0.6;
      }
      .takeover-name {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        line-height: 1.05;
      }
      .takeover-assist {
        margin-top: 4px;
        font-family: 'AM Industry Inc', sans-serif;
        letter-spacing: 0.14em;
      }
      .takeover-meta { margin-top: 4px; opacity: 0.8; }

      .drawer { position: relative; padding: 12px 14px 14px; background: rgba(0, 0, 0, 0.3); }
      .tiles { display: flex; gap: 8px; flex-wrap: wrap; }
      .tile {
        flex: 1 1 130px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-align: left;
        padding: 9px 11px;
        border-radius: 6px;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--am-line);
        color: inherit;
        font-family: inherit;
      }
      .tile-label {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        font-size: 9px;
        letter-spacing: 0.18em;
        color: var(--am-muted);
      }
      .tile-main { font-size: 17px; font-weight: 700; }
      .tile-sub { font-size: 10px; color: var(--am-muted); font-variant-numeric: tabular-nums; }

      .panel {
        margin-top: 10px;
        padding: 12px;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid var(--am-line);
      }
      .panel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        gap: 9px;
      }
      .panel-item { display: flex; flex-direction: column; }
      .panel-key {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        font-size: 9px;
        letter-spacing: 0.16em;
        color: var(--am-muted);
      }
      .panel-val { font-size: 12px; }
      .panel-link {
        display: inline-block;
        margin-top: 10px;
        padding: 6px 13px;
        border-radius: 4px;
        background: var(--am-accent);
        color: #fff;
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        font-size: 10px;
        letter-spacing: 0.18em;
        text-decoration: none;
      }
      .panel-meta { margin-top: 9px; font-size: 10px; color: var(--am-muted); text-align: center; }

      .cmp-head {
        display: flex;
        justify-content: space-between;
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        font-size: 9px;
        letter-spacing: 0.18em;
        color: var(--am-muted);
        margin-bottom: 8px;
      }
      .cmp {
        display: grid;
        grid-template-columns: 44px 1fr 44px;
        align-items: center;
        gap: 8px;
        margin-bottom: 7px;
      }
      .cmp-val { font-size: 12px; font-variant-numeric: tabular-nums; }
      .cmp-val.opp { text-align: right; }
      .cmp-mid { display: flex; flex-direction: column; gap: 3px; }
      .cmp-label {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        font-size: 9px;
        letter-spacing: 0.14em;
        color: var(--am-muted);
        text-align: center;
      }
      .cmp-track { display: flex; height: 5px; border-radius: 3px; overflow: hidden; }
      .cmp-fill.own { background: var(--am-accent); }
      .cmp-fill.opp { background: rgba(255, 255, 255, 0.2); }

      .timeline { max-height: 330px; overflow-y: auto; }
      .tl-block { margin-bottom: 11px; }
      .tl-head {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        font-size: 9px;
        letter-spacing: 0.18em;
        color: var(--am-muted);
        padding-bottom: 4px;
        border-bottom: 1px solid var(--am-line);
        margin-bottom: 6px;
      }
      .tl-row {
        display: grid;
        grid-template-columns: 42px 8px 1fr auto;
        align-items: center;
        gap: 8px;
        padding: 3px 0;
      }
      .tl-time { font-size: 10px; color: var(--am-muted); font-variant-numeric: tabular-nums; }
      .tl-mark { width: 8px; height: 8px; border-radius: 50%; background: rgba(255, 255, 255, 0.25); }
      .tl-row.own .tl-mark { background: var(--am-accent); }
      .tl-row.penalty .tl-mark { border-radius: 1px; height: 11px; width: 4px; }
      .tl-body { display: flex; flex-direction: column; min-width: 0; }
      .tl-title { font-size: 12px; }
      .tl-sub { font-size: 9px; color: var(--am-muted); }
      .tl-badge {
        font-size: 9px;
        padding: 1px 6px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.09);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      /* Sizes follow the card's own width, so the same markup is a dashboard
         tile and a wall board. */
      @container (min-width: 0px) {
        .ring { font-size: clamp(8px, 1.3cqw, 18px); }
        .face { width: clamp(46px, 9cqw, 150px); padding: clamp(10px, 1.6cqw, 28px) 0; }
        .face-crest { height: clamp(26px, 5cqw, 84px); }
        .face-v { font-size: clamp(16px, 3.2cqw, 54px); }
        .screen-mark { height: clamp(40px, 12cqw, 200px); }
        .caption-main { font-size: clamp(16px, 3.4cqw, 54px); }
        .caption-sub { font-size: clamp(10px, 1.6cqw, 24px); }
        .caption-meta { font-size: clamp(8px, 1.2cqw, 17px); }
        .board {
          margin: 0 clamp(8px, 1.4cqw, 26px);
          padding: clamp(12px, 2cqw, 38px) clamp(12px, 2.2cqw, 40px);
          border-radius: clamp(8px, 0.9cqw, 18px);
          gap: clamp(8px, 1.4cqw, 26px);
        }
        .core { gap: clamp(14px, 4cqw, 80px); }
        .team-code { font-size: clamp(10px, 1.7cqw, 26px); margin-bottom: clamp(3px, 0.5cqw, 10px); }
        .team-score { font-size: clamp(40px, 12cqw, 180px); }
        .clock { font-size: clamp(34px, 11cqw, 165px); }
        .board-mark img { height: clamp(16px, 2.6cqw, 44px); }
        .clock-dot {
          width: clamp(7px, 0.85cqw, 16px);
          height: clamp(7px, 0.85cqw, 16px);
          margin-bottom: clamp(2px, 0.3cqw, 6px);
        }
        .stripe-bar { width: clamp(12px, 1.7cqw, 32px); height: clamp(4px, 0.5cqw, 10px); }
        .pen { font-size: clamp(10px, 1.5cqw, 23px); }
        .state { font-size: clamp(8px, 1.2cqw, 17px); }
        .periods, .shots { font-size: clamp(11px, 1.5cqw, 22px); }
        .period-cell b, .shots i { font-size: clamp(8px, 1.1cqw, 15px); }
        .lastgoal { font-size: clamp(11px, 1.4cqw, 20px); }
        .lastgoal-tag { font-size: clamp(8px, 1.1cqw, 15px); }
        .standby-word { font-size: clamp(18px, 5cqw, 70px); }
        .takeover-word { font-size: clamp(48px, 22cqw, 320px); }
        .takeover-name { font-size: clamp(20px, 6cqw, 84px); }
        .takeover-jersey { font-size: clamp(26px, 7.5cqw, 104px); }
        .takeover-photo {
          width: clamp(70px, 14cqw, 230px);
          height: clamp(70px, 14cqw, 230px);
        }
        .takeover-assist { font-size: clamp(9px, 1.5cqw, 20px); }
        .takeover-meta { font-size: clamp(10px, 1.6cqw, 22px); }
      }

      /* A narrow card drops the outer penalty columns into the flow and
         keeps the strip readable. */
      @container (max-width: 400px) {
        .board { grid-template-columns: 1fr; }
        .board-mark { display: none; }
        .pen-zone.left, .pen-zone.right { align-items: center; }
        .pen-zone:empty { display: none; }
        .takeover.detail { grid-auto-flow: row; gap: 10px; }
        .takeover-stack { text-align: center; }
      }

      @supports not (container-type: inline-size) {
        .team-score { font-size: 48px; }
        .clock { font-size: 38px; }
      }`;
  }
}

customElements.define('adler-mannheim-scoreboard', AdlerMannheimScoreboard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'adler-mannheim-scoreboard',
  name: 'Adler Mannheim Scoreboard',
  description: `Anzeigetafel nach dem Videowuerfel der SAP Arena (v${CARD_VERSION})`,
  preview: false,
});
