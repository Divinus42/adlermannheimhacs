const CARD_VERSION = '8.0.0';

/* Period length in seconds. Goal and penalty times in the API are the time
   elapsed inside the period, counting up from 00:00, which the two empty-net
   goals of a finished game confirm: they sit at 17:22 and 18:46 of the third.
   The board in the arena counts the same period down, so that is what the
   card shows. */
const PERIOD_SECONDS = 20 * 60;

/* Minutes a penalty keeps a player in the box, by the label the API uses. */
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

/* The club serves one gameday key visual per competition and names it per
   game. This mapping only covers the case where an older integration build
   does not pass the url through yet. */
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

/* The club's own typefaces, served with Access-Control-Allow-Origin: *.
   Industry is the display face of the arena graphics, 72 the text face. */
const FONT_BASE = 'https://www.adler-mannheim.de/_resources/themes/homepage/css/fonts';

const DEFAULT_ENTITIES = {
  entity: 'sensor.adler_mannheim_current_game',
  entity_next: 'sensor.adler_mannheim_next_game',
  entity_last: 'sensor.adler_mannheim_last_game',
  entity_clock: 'sensor.adler_mannheim_clock',
  entity_stats: 'sensor.adler_mannheim_game_stats',
};

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatSeconds(totalSeconds) {
  const safe = Math.max(0, Math.round(totalSeconds));
  return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
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
  if (!text) {
    return fallback;
  }
  return text.startsWith('#') ? text : `#${text}`;
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
    this._signature = '';
    this._openPanel = null;
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
      return { state: live, mode: 'live' };
    }
    const next = this._state('entity_next');
    if (next && next.attributes && next.attributes.game_id) {
      return { state: next, mode: 'next' };
    }
    const last = this._state('entity_last');
    if (last && last.attributes && last.attributes.game_id) {
      return { state: last, mode: 'final' };
    }
    return null;
  }

  _stats() {
    const stats = this._state('entity_stats');
    return stats ? stats.attributes || {} : {};
  }

  /* ── Clock ───────────────────────────────────────── */

  /* The sensor is polled every few seconds, so the card carries the clock
     forward from the moment the state arrived. Without that the time would
     jump in steps as wide as the poll interval. */
  _clock() {
    const state = this._state('entity_clock');
    if (!state) {
      return null;
    }

    const attrs = state.attributes || {};
    const period = attrs.period || null;
    const elapsedAtUpdate = attrs.elapsed_seconds;

    if (elapsedAtUpdate === null || elapsedAtUpdate === undefined) {
      return { period, remaining: null, elapsedInPeriod: null, source: attrs.source };
    }

    let drift = 0;
    if (attrs.running && state.last_updated) {
      drift = (Date.now() - new Date(state.last_updated).getTime()) / 1000;
      drift = Math.max(0, Math.min(drift, PERIOD_SECONDS));
    }

    const elapsedInPeriod = Math.min(
      PERIOD_SECONDS,
      elapsedAtUpdate + drift - (period ? (period - 1) * PERIOD_SECONDS : 0),
    );

    return {
      period,
      elapsedInPeriod,
      remaining: PERIOD_SECONDS - elapsedInPeriod,
      source: attrs.source,
    };
  }

  _startTicking() {
    if (this._tickHandle) {
      return;
    }
    this._tickHandle = window.setInterval(() => {
      const game = this._game();
      if ((game && (game.mode === 'live' || game.mode === 'next')) || this._goalOverlay) {
        this._paintVolatile();
      }
    }, 1000);
  }

  _stopTicking() {
    if (this._tickHandle) {
      window.clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
  }

  /* Repaint only what moves every second, so the goal animation is not
     rebuilt mid-flight and the key visual is not re-decoded. */
  _paintVolatile() {
    const clockNode = this.querySelector('[data-role="clock"]');
    if (clockNode) {
      const clock = this._clock();
      if (clock && clock.remaining !== null) {
        clockNode.textContent = formatSeconds(clock.remaining);
      }
    }

    this.querySelectorAll('[data-countdown]').forEach((node) => {
      node.textContent = this._countdown(node.getAttribute('data-countdown')) || '';
    });

    const boxes = this.querySelectorAll('[data-role="penalties"]');
    if (boxes.length) {
      const active = this._activePenalties();
      boxes.forEach((node) => {
        const adlerSide = node.getAttribute('data-side') === 'adler';
        node.innerHTML = this._renderPenaltyBox(
          active.filter((entry) => entry.isAdler === adlerSide),
        );
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
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  /* ── Penalties ───────────────────────────────────── */

  /* A penalty is in force from the second it was handed out until its minutes
     are served, both measured inside the same period, so the boxes show what
     the arena shows instead of staying empty. */
  _activePenalties() {
    const game = this._game();
    if (!game || game.mode !== 'live') {
      return [];
    }

    const clock = this._clock();
    if (!clock || clock.elapsedInPeriod === null || !clock.period) {
      return [];
    }

    const penalties = (game.state.attributes || {}).penalties || [];
    const active = [];

    penalties.forEach((penalty) => {
      if (penalty.period !== clock.period) {
        return;
      }
      const start = parseClockToSeconds(penalty.time);
      if (start === null) {
        return;
      }
      const end = start + (PENALTY_MINUTES[penalty.minutes] || 2) * 60;
      if (clock.elapsedInPeriod < start || clock.elapsedInPeriod >= end) {
        return;
      }
      active.push({
        jersey: penalty.player_jersey,
        player: penalty.player,
        isAdler: Boolean(penalty.is_adler),
        remaining: end - clock.elapsedInPeriod,
      });
    });

    return active.sort((a, b) => a.remaining - b.remaining);
  }

  _renderPenaltyBox(entries) {
    if (!entries.length) {
      return '<span class="pen-empty">&mdash;</span>';
    }
    return entries
      .slice(0, 2)
      .map((entry) => `
        <span class="pen-chip ${entry.isAdler ? 'own' : 'opp'}">
          <b>${escapeHtml(entry.jersey || '?')}</b>${formatSeconds(entry.remaining)}
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

    const fill = this._config.full_height ? ' fill' : '';

    this.innerHTML = `
      <ha-card class="${fill.trim()}" style="--am-base:${theme.base};--am-accent:${theme.accent}">
        <style>${this._styles()}</style>
        <div class="cube">
          <div class="cube-bg" style="${theme.background}"></div>
          <div class="cube-scrim"></div>
          <div class="cube-body">
            ${game ? this._renderBoard(game) : this._renderStandby()}
          </div>
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

  /* The full-height board is meant to be looked at from across the room, so
     it drops the tiles and panels unless they are asked for explicitly. */
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
      stats.shots_adler, stats.shots_opponent, clock.period,
      this._openPanel, this._goalPhase,
      this._config.full_height, this._config.show_details,
    ].join('|');
  }

  /* The club publishes a gameday key visual per competition and the API names
     it per game, so the card takes its colours from the game it shows. */
  _theme(game) {
    const attrs = game ? game.state.attributes || {} : {};
    const competition = attrs.competition || 'DEL';
    const base = cssColor(attrs.league_color, FALLBACK_COLORS[competition] || '#00264d');
    const url = attrs.league_background || FALLBACK_BACKGROUNDS[competition];
    const accent = competition === 'CHL' ? '#ff005a' : '#e50026';
    return {
      base,
      accent,
      background: url ? `background-image:url('${encodeURI(url)}')` : '',
    };
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

    const header = [
      attrs.competition_title || attrs.competition,
      attrs.matchday ? `${attrs.matchday}. SPIELTAG` : null,
      (attrs.arena || '').trim().toUpperCase() || null,
    ].filter(Boolean).join('  ·  ');

    let periodLabel = clock && clock.period ? `${clock.period}. DRITTEL` : '';
    if (attrs.overtime) {
      periodLabel = 'VERLÄNGERUNG';
    }
    if (attrs.shootout) {
      periodLabel = 'PENALTYSCHIESSEN';
    }
    if (game.mode === 'final') {
      periodLabel = 'ENDSTAND';
    }
    if (isNext) {
      periodLabel = attrs.is_home ? 'HEIMSPIEL' : 'AUSWÄRTSSPIEL';
    }

    return `
      <div class="head">
        <span class="head-text">${escapeHtml(header)}</span>
        ${attrs.competition_logo
          ? `<img class="head-logo" src="${escapeHtml(attrs.competition_logo)}" alt="" onerror="this.remove()"/>`
          : ''}
      </div>

      <div class="matchup">
        ${this._renderSide(attrs, 'home', homeShort, adlerHome)}
        <div class="centre">
          ${isNext
            ? `<div class="kickoff">
                 <div class="kickoff-time">${escapeHtml(game.state.state || '')}</div>
                 <div class="kickoff-cd" data-countdown="${escapeHtml(attrs.match_start_iso || '')}"></div>
               </div>`
            : `<div class="score">
                 <span class="score-num">${escapeHtml(attrs.score_home ?? 0)}</span>
                 <span class="score-sep">:</span>
                 <span class="score-num">${escapeHtml(attrs.score_away ?? 0)}</span>
               </div>`}
          ${isLive
            ? `<div class="clockbox"><span class="clock" data-role="clock">--:--</span></div>`
            : ''}
          <div class="period">${escapeHtml(periodLabel)}</div>
        </div>
        ${this._renderSide(attrs, 'away', awayShort, !adlerHome)}
      </div>

      ${isLive ? this._renderPenaltyRow(adlerHome) : ''}
      ${isNext ? '' : this._renderPeriodStrip(attrs, stats)}
      ${isLive ? this._renderLastGoal(attrs) : ''}`;
  }

  _renderSide(attrs, side, short, isAdler) {
    const logo = side === 'home' ? attrs.home_logo : attrs.away_logo;
    const rank = side === 'home' ? attrs.rank_home : attrs.rank_away;
    const name = side === 'home' ? attrs.home_team : attrs.away_team;
    return `
      <div class="side ${isAdler ? 'adler' : ''}">
        ${logo ? `<img class="side-logo" src="${escapeHtml(logo)}" alt="" onerror="this.remove()"/>` : ''}
        <div class="side-short">${escapeHtml(short)}</div>
        <div class="side-name">${escapeHtml(name || '')}</div>
        ${rank ? `<div class="side-rank">PLATZ ${escapeHtml(rank)}</div>` : ''}
      </div>`;
  }

  _renderPenaltyRow(adlerHome) {
    return `
      <div class="pen-row">
        <div class="pen-cell">
          <span class="pen-label">STRAFEN</span>
          <span class="pen-box" data-role="penalties" data-side="${adlerHome ? 'adler' : 'opponent'}"></span>
        </div>
        <div class="pen-cell right">
          <span class="pen-box" data-role="penalties" data-side="${adlerHome ? 'opponent' : 'adler'}"></span>
          <span class="pen-label">STRAFEN</span>
        </div>
      </div>`;
  }

  _renderPeriodStrip(attrs, stats) {
    const cells = [];
    for (let index = 1; index <= 3; index += 1) {
      const value = attrs[`period_${index}`];
      cells.push({ label: `${index}.`, value });
    }
    if (attrs.overtime) {
      cells.push({ label: 'V', value: attrs.overtime });
    }
    if (attrs.shootout) {
      cells.push({ label: 'P', value: attrs.shootout });
    }

    const adlerHome = attrs.is_home === true;
    const homeShots = adlerHome ? stats.shots_adler : stats.shots_opponent;
    const awayShots = adlerHome ? stats.shots_opponent : stats.shots_adler;

    return `
      <div class="strip">
        <div class="strip-periods">
          ${cells.map((cell) => `
            <span class="strip-cell ${cell.value ? '' : 'dim'}">
              <b>${escapeHtml(cell.label)}</b>${escapeHtml(cell.value || '–')}
            </span>`).join('')}
        </div>
        ${homeShots === undefined ? '' : `
          <div class="strip-shots">
            <b>${escapeHtml(homeShots ?? 0)}</b>
            <span>SCHÜSSE</span>
            <b>${escapeHtml(awayShots ?? 0)}</b>
          </div>`}
      </div>`;
  }

  _renderLastGoal(attrs) {
    const goals = attrs.goals || [];
    if (!goals.length || !goals[goals.length - 1].scorer) {
      return '';
    }
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
      return `
        <div class="takeover shout">
          <div class="takeover-word">TOR</div>
        </div>`;
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

  /* ── Drawer below the board ──────────────────────── */

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
        --am-ink: #ffffff;
        --am-muted: rgba(255, 255, 255, 0.62);
        --am-line: rgba(255, 255, 255, 0.14);
        overflow: hidden;
        border: none;
        padding: 0;
        background: var(--am-base);
        color: var(--am-ink);
        font-family: 'AM 72', system-ui, sans-serif;
      }

      /* Everything below scales with the width of the card, not the viewport,
         so the same card reads as a small dashboard tile and as a full-screen
         board on a wall display without a second set of sizes. */
      .cube {
        position: relative;
        overflow: hidden;
        container-type: inline-size;
      }
      ha-card.fill {
        min-height: calc(100vh - 56px);
        display: flex;
        flex-direction: column;
      }
      ha-card.fill .cube {
        flex: 1;
        display: flex;
        flex-direction: column;
      }
      ha-card.fill .cube-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 2cqw;
      }
      .cube-bg {
        position: absolute;
        inset: 0;
        background-color: var(--am-base);
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
      }
      /* The key visual is busy in the upper left, so the scrim is strongest
         there and the score stays readable on every competition palette. */
      .cube-scrim {
        position: absolute;
        inset: 0;
        background:
          linear-gradient(105deg, rgba(0, 0, 0, 0.72) 0%, rgba(0, 0, 0, 0.28) 46%, rgba(0, 0, 0, 0.66) 100%),
          linear-gradient(180deg, rgba(0, 0, 0, 0.42) 0%, rgba(0, 0, 0, 0) 38%, rgba(0, 0, 0, 0.55) 100%);
      }
      .cube-body { position: relative; padding: 14px 16px 16px; }

      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--am-line);
      }
      .head-text {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 11px;
        letter-spacing: 0.18em;
        color: var(--am-muted);
        text-transform: uppercase;
      }
      .head-logo { height: 22px; width: auto; opacity: 0.95; }

      .matchup {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 10px;
        padding: 16px 0 12px;
      }
      .side { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
      .side-logo { height: 54px; width: auto; object-fit: contain; }
      .side-short {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 30px;
        line-height: 1;
        letter-spacing: 0.02em;
      }
      .side.adler .side-short { color: var(--am-accent); }
      /* Two lines rather than an ellipsis: "Adler Mannhei…" reads worse than
         a wrapped club name. */
      .side-name {
        font-size: 10px;
        color: var(--am-muted);
        text-align: center;
        max-width: 18ch;
        line-height: 1.25;
      }
      .side-rank {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 9px;
        letter-spacing: 0.14em;
        color: var(--am-muted);
      }

      .centre { text-align: center; min-width: 150px; }
      .score {
        display: flex;
        align-items: baseline;
        justify-content: center;
        gap: 8px;
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        line-height: 0.9;
      }
      .score-num {
        font-size: 64px;
        text-shadow: 0 0 28px rgba(0, 0, 0, 0.55);
      }
      .score-sep { font-size: 34px; color: var(--am-muted); }
      .clockbox {
        margin-top: 6px;
        display: inline-flex;
        padding: 3px 12px;
        border-radius: 3px;
        background: rgba(0, 0, 0, 0.55);
        border: 1px solid var(--am-line);
      }
      .clock {
        font-family: ui-monospace, monospace;
        font-size: 24px;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: var(--am-accent);
        font-variant-numeric: tabular-nums;
      }
      .period {
        margin-top: 7px;
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 10px;
        letter-spacing: 0.2em;
        color: var(--am-muted);
      }
      .kickoff-time {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 34px;
        line-height: 1;
      }
      .kickoff-cd {
        margin-top: 5px;
        font-family: ui-monospace, monospace;
        font-size: 17px;
        color: var(--am-accent);
        font-variant-numeric: tabular-nums;
      }

      .pen-row {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 0;
        border-top: 1px solid var(--am-line);
      }
      .pen-cell { display: flex; align-items: center; gap: 7px; }
      .pen-cell.right { flex-direction: row-reverse; }
      .pen-label {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 9px;
        letter-spacing: 0.16em;
        color: var(--am-muted);
      }
      .pen-box { display: flex; gap: 4px; align-items: center; min-height: 20px; }
      .pen-empty { color: rgba(255, 255, 255, 0.28); font-size: 13px; }
      .pen-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 7px;
        border-radius: 3px;
        font-family: ui-monospace, monospace;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        background: rgba(0, 0, 0, 0.5);
        border-left: 2px solid rgba(255, 255, 255, 0.4);
      }
      .pen-chip.own { border-left-color: var(--am-accent); }
      .pen-chip b { font-family: 'AM Industry Inc', sans-serif; opacity: 0.8; }

      .strip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding-top: 10px;
        border-top: 1px solid var(--am-line);
      }
      .strip-periods { display: flex; gap: 6px; flex-wrap: wrap; }
      .strip-cell {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
        padding: 3px 8px;
        border-radius: 3px;
        background: rgba(0, 0, 0, 0.42);
        font-family: ui-monospace, monospace;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .strip-cell.dim { opacity: 0.4; }
      .strip-cell b {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 9px;
        letter-spacing: 0.1em;
        color: var(--am-muted);
      }
      .strip-shots {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: ui-monospace, monospace;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
      }
      .strip-shots span {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 9px;
        letter-spacing: 0.16em;
        color: var(--am-muted);
      }

      .lastgoal {
        margin-top: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 7px 10px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.5);
        border-left: 3px solid rgba(255, 255, 255, 0.35);
      }
      .lastgoal.own { border-left-color: var(--am-accent); }
      .lastgoal-tag {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 9px;
        letter-spacing: 0.16em;
        color: var(--am-muted);
      }
      .lastgoal-name {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 15px;
      }
      .lastgoal-assist { font-size: 11px; color: var(--am-muted); }
      .lastgoal-time {
        margin-left: auto;
        font-family: ui-monospace, monospace;
        font-size: 11px;
        color: var(--am-muted);
      }

      .standby { padding: 44px 0; text-align: center; }
      .standby-word {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 30px;
        letter-spacing: 0.03em;
      }
      .standby-sub {
        margin-top: 6px;
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 10px;
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
        background: radial-gradient(circle at 50% 45%, var(--am-accent) 0%, rgba(0, 0, 0, 0.94) 72%);
        animation: fade 0.22s ease-out;
      }
      @keyframes fade { from { opacity: 0; } }
      .takeover-word {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: clamp(56px, 18vw, 128px);
        letter-spacing: 0.04em;
        animation: punch 0.62s cubic-bezier(.2,.8,.2,1) infinite alternate;
      }
      @keyframes punch { to { transform: scale(1.09); } }
      .takeover.detail {
        grid-auto-flow: column;
        gap: 18px;
        padding: 18px;
        place-items: center;
      }
      .takeover-photo {
        width: 92px;
        height: 92px;
        border-radius: 50%;
        object-fit: cover;
        border: 2px solid rgba(255, 255, 255, 0.85);
      }
      .takeover-stack { text-align: left; }
      .takeover-jersey {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 34px;
        line-height: 1;
        opacity: 0.65;
      }
      .takeover-name {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 26px;
        line-height: 1.05;
      }
      .takeover-assist {
        margin-top: 4px;
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 10px;
        letter-spacing: 0.14em;
      }
      .takeover-meta {
        margin-top: 4px;
        font-size: 11px;
        opacity: 0.8;
      }

      .drawer { padding: 12px 16px 16px; background: rgba(0, 0, 0, 0.26); }
      .tiles { display: flex; gap: 8px; flex-wrap: wrap; }
      .tile {
        flex: 1 1 130px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-align: left;
        padding: 8px 10px;
        border-radius: 4px;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid var(--am-line);
        color: inherit;
        font-family: inherit;
      }
      .tile-label {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 8px;
        letter-spacing: 0.16em;
        color: var(--am-muted);
      }
      .tile-main {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 17px;
      }
      .tile-sub {
        font-size: 10px;
        color: var(--am-muted);
        font-variant-numeric: tabular-nums;
      }

      .panel {
        margin-top: 10px;
        padding: 11px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.36);
        border: 1px solid var(--am-line);
      }
      .panel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        gap: 8px;
      }
      .panel-item { display: flex; flex-direction: column; }
      .panel-key {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 8px;
        letter-spacing: 0.14em;
        color: var(--am-muted);
      }
      .panel-val { font-size: 12px; }
      .panel-link {
        display: inline-block;
        margin-top: 9px;
        padding: 5px 12px;
        border-radius: 3px;
        background: var(--am-accent);
        color: #fff;
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 10px;
        letter-spacing: 0.16em;
        text-decoration: none;
      }
      .panel-meta { margin-top: 8px; font-size: 10px; color: var(--am-muted); text-align: center; }

      .cmp-head {
        display: flex;
        justify-content: space-between;
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 8px;
        letter-spacing: 0.16em;
        color: var(--am-muted);
        margin-bottom: 7px;
      }
      .cmp {
        display: grid;
        grid-template-columns: 42px 1fr 42px;
        align-items: center;
        gap: 7px;
        margin-bottom: 7px;
      }
      .cmp-val {
        font-family: ui-monospace, monospace;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .cmp-val.opp { text-align: right; }
      .cmp-mid { display: flex; flex-direction: column; gap: 3px; }
      .cmp-label {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 8px;
        letter-spacing: 0.12em;
        color: var(--am-muted);
        text-align: center;
      }
      .cmp-track { display: flex; height: 5px; border-radius: 3px; overflow: hidden; }
      .cmp-fill.own { background: var(--am-accent); }
      .cmp-fill.opp { background: rgba(255, 255, 255, 0.22); }

      .timeline { max-height: 330px; overflow-y: auto; }
      .tl-block { margin-bottom: 10px; }
      .tl-head {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 8px;
        letter-spacing: 0.16em;
        color: var(--am-muted);
        padding-bottom: 4px;
        border-bottom: 1px solid var(--am-line);
        margin-bottom: 5px;
      }
      .tl-row {
        display: grid;
        grid-template-columns: 40px 8px 1fr auto;
        align-items: center;
        gap: 7px;
        padding: 3px 0;
      }
      .tl-time {
        font-family: ui-monospace, monospace;
        font-size: 10px;
        color: var(--am-muted);
        font-variant-numeric: tabular-nums;
      }
      .tl-mark {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.28);
      }
      .tl-row.own .tl-mark { background: var(--am-accent); }
      .tl-row.penalty .tl-mark { border-radius: 1px; height: 11px; width: 4px; }
      .tl-body { display: flex; flex-direction: column; min-width: 0; }
      .tl-title { font-size: 12px; }
      .tl-sub { font-size: 9px; color: var(--am-muted); }
      .tl-badge {
        font-family: ui-monospace, monospace;
        font-size: 9px;
        padding: 1px 6px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.1);
        white-space: nowrap;
      }

      /* Fluid sizing against the card's own width. The clamps keep a tiny
         card legible and stop a full-screen board from growing absurd. */
      @container (min-width: 0px) {
        .cube-body { padding: clamp(12px, 2.2cqw, 44px) clamp(12px, 2.6cqw, 52px); }
        .head-text { font-size: clamp(9px, 1.5cqw, 19px); }
        .head-logo { height: clamp(18px, 3cqw, 46px); }
        .matchup { padding: clamp(12px, 2.4cqw, 48px) 0 clamp(8px, 1.8cqw, 34px); }
        .side-logo { height: clamp(46px, 13cqw, 200px); }
        .side-short { font-size: clamp(26px, 8.5cqw, 128px); }
        .side-name { font-size: clamp(10px, 1.7cqw, 22px); }
        .side-rank { font-size: clamp(8px, 1.3cqw, 17px); }
        .score-num { font-size: clamp(42px, 15cqw, 220px); }
        .score-sep { font-size: clamp(22px, 7cqw, 100px); }
        .clock { font-size: clamp(18px, 6cqw, 96px); }
        .clockbox { padding: clamp(2px, 0.5cqw, 10px) clamp(9px, 2cqw, 36px); }
        .period { font-size: clamp(9px, 1.6cqw, 21px); }
        /* Before a game the pairing carries the card, so the kickoff is a
           caption and the countdown is the number worth looking at. */
        .kickoff-time { font-size: clamp(12px, 2.3cqw, 30px); }
        .kickoff-cd { font-size: clamp(22px, 7cqw, 104px); }
        .pen-label { font-size: clamp(8px, 1.2cqw, 16px); }
        .pen-chip { font-size: clamp(10px, 1.7cqw, 23px); }
        .strip-cell { font-size: clamp(11px, 1.9cqw, 26px); }
        .strip-cell b { font-size: clamp(8px, 1.2cqw, 16px); }
        .strip-shots { font-size: clamp(12px, 2.1cqw, 28px); }
        .strip-shots span { font-size: clamp(8px, 1.3cqw, 17px); }
        .lastgoal-name { font-size: clamp(13px, 2.6cqw, 34px); }
        .lastgoal-tag, .lastgoal-assist, .lastgoal-time { font-size: clamp(9px, 1.4cqw, 18px); }
        .takeover-word { font-size: clamp(48px, 22cqw, 320px); }
        .takeover-name { font-size: clamp(20px, 6cqw, 84px); }
        .takeover-jersey { font-size: clamp(26px, 7.5cqw, 104px); }
        .takeover-photo { width: clamp(70px, 14cqw, 230px); height: clamp(70px, 14cqw, 230px); }
        .takeover-assist { font-size: clamp(9px, 1.5cqw, 20px); }
        .takeover-meta { font-size: clamp(10px, 1.6cqw, 22px); }
        .standby-word { font-size: clamp(24px, 8cqw, 110px); }
      }

      /* A narrow card drops what does not survive the squeeze. */
      @container (max-width: 380px) {
        .side-name { display: none; }
        .takeover.detail { grid-auto-flow: row; gap: 10px; }
        .takeover-stack { text-align: center; }
        .centre { min-width: 104px; }
      }

      /* Without container query support the card keeps its base sizes, so it
         degrades to the dashboard-card look rather than to nothing. */
      @supports not (container-type: inline-size) {
        .cube-body { padding: 14px 16px 16px; }
      }`;
  }
}

customElements.define('adler-mannheim-scoreboard', AdlerMannheimScoreboard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'adler-mannheim-scoreboard',
  name: 'Adler Mannheim Scoreboard',
  description: `Anzeigetafel im Gameday-Look des Vereins, mit Spieluhr und Strafzeiten (v${CARD_VERSION})`,
  preview: false,
});
