const CARD_VERSION = '9.0.0';

/* Built against a photograph of the arena cube. What that board does, and
   what this card therefore does too:

   - the score strip is a near-black panel, set apart from the video area.
     The key visual and the eagle live on the surrounding faces, never behind
     the numbers.
   - the numerals are upright, not italic, and white.
   - the team code is a small letterspaced caption ABOVE its own score
     ("MAN" over "6"), and there are no club crests inside the strip.
   - the clock sits between the two scores and switches to tenths of a second
     in the closing minute of a period ("0.0").
   - a penalty reads as plain text, "#75 - 0:15".

   The cube is markedly calmer than a dashboard card wants to be, and that
   restraint is the point. */
const PERIOD_SECONDS = 20 * 60;

/* Below this many seconds remaining the clock counts in tenths, the way the
   board does in the closing minute. */
const TENTHS_BELOW_SECONDS = 60;

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

  /* Tenths need a faster tick, but only in the closing minute. Outside that
     window a second is plenty, and the text is only rewritten when it
     actually changed. */
  _startTicking() {
    const game = this._game();
    const clock = this._clock();
    const live = game && game.mode === 'live';
    const closing = live && clock && clock.remaining !== null
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
    const clockNode = this.querySelector('[data-role="clock"]');
    if (clockNode) {
      const clock = this._clock();
      if (clock && clock.remaining !== null) {
        this._write(clockNode, formatClock(clock.remaining));
        clockNode.classList.toggle('tenths', clock.remaining < TENTHS_BELOW_SECONDS);
      }
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
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  /* ── Penalties ───────────────────────────────────── */

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
        isAdler: Boolean(penalty.is_adler),
        remaining: end - clock.elapsedInPeriod,
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
      <ha-card class="${fill}" style="--am-base:${theme.base};--am-accent:${theme.accent}">
        <style>${this._styles()}</style>
        <div class="cube">
          <div class="surround" style="${theme.background}"></div>
          <div class="surround-scrim"></div>
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

    let state = '';
    if (game.mode === 'final') {
      state = 'ENDSTAND';
    } else if (isNext) {
      state = attrs.is_home ? 'HEIMSPIEL' : 'AUSWÄRTSSPIEL';
    } else if (attrs.shootout) {
      state = 'PENALTYSCHIESSEN';
    } else if (attrs.overtime) {
      state = 'VERLÄNGERUNG';
    }

    return `
      <div class="head">
        <span class="head-text">${escapeHtml(header)}</span>
        <span class="head-right">
          ${attrs.home_logo ? `<img class="head-logo" src="${escapeHtml(attrs.home_logo)}" alt="" onerror="this.remove()"/>` : ''}
          ${attrs.away_logo ? `<img class="head-logo" src="${escapeHtml(attrs.away_logo)}" alt="" onerror="this.remove()"/>` : ''}
        </span>
      </div>

      <div class="board">
        <div class="pen-zone left" data-role="penalties" data-side="${adlerHome ? 'adler' : 'opponent'}"></div>

        <div class="core">
          <div class="team">
            <span class="team-code">${escapeHtml(homeShort)}</span>
            ${isNext
              ? '<span class="team-dash">–</span>'
              : `<span class="team-score">${escapeHtml(attrs.score_home ?? 0)}</span>`}
          </div>

          <div class="middle">
            ${isLive ? '<span class="live-dot"></span>' : ''}
            ${isNext
              ? `<span class="kickoff" data-countdown="${escapeHtml(attrs.match_start_iso || '')}"></span>`
              : `<span class="clock ${isLive ? '' : 'idle'}" data-role="clock">${isLive ? '--:--' : escapeHtml(this._finalLabel(attrs))}</span>`}
            ${this._renderPeriodPips(attrs, clock, isNext)}
          </div>

          <div class="team">
            <span class="team-code">${escapeHtml(awayShort)}</span>
            ${isNext
              ? '<span class="team-dash">–</span>'
              : `<span class="team-score">${escapeHtml(attrs.score_away ?? 0)}</span>`}
          </div>
        </div>

        <div class="pen-zone right" data-role="penalties" data-side="${adlerHome ? 'opponent' : 'adler'}"></div>
      </div>

      ${state || isNext ? `<div class="state">${escapeHtml(state)}${isNext ? `<span class="state-time">${escapeHtml(game.state.state || '')}</span>` : ''}</div>` : ''}

      <div class="foot">
        ${this._renderPeriodScores(attrs)}
        ${this._renderShots(attrs, stats)}
      </div>

      ${isLive ? this._renderLastGoal(attrs) : ''}`;
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

  /* Three pips under the clock for the three periods, the current one lit.
     The cube shows three small markers there; what they encode is not
     readable from a photograph, so this is the useful reading rather than a
     claim about the original. */
  _renderPeriodPips(attrs, clock, isNext) {
    if (isNext) {
      return '';
    }
    const current = clock && clock.period ? clock.period : 0;
    let pips = '';
    for (let index = 1; index <= 3; index += 1) {
      const played = Boolean(attrs[`period_${index}`]);
      const live = index === current;
      pips += `<span class="pip ${live ? 'live' : ''} ${played ? 'played' : ''}"></span>`;
    }
    return `<span class="pips">${pips}</span>`;
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
      ha-card.fill { min-height: calc(100vh - 56px); display: flex; flex-direction: column; }
      ha-card.fill .cube { flex: 1; display: flex; flex-direction: column; }
      ha-card.fill .cube-body { flex: 1; display: flex; flex-direction: column; justify-content: center; }

      .cube { position: relative; overflow: hidden; container-type: inline-size; }

      /* The key visual belongs on the surrounding faces, not behind the
         numbers. It sits at the edges and is pushed far back. */
      .surround {
        position: absolute;
        inset: 0;
        background-color: var(--am-base);
        background-size: cover;
        background-position: center;
        opacity: 0.5;
      }
      .surround-scrim {
        position: absolute;
        inset: 0;
        background:
          radial-gradient(130% 90% at 50% 58%, rgba(5, 8, 11, 0.96) 38%, rgba(5, 8, 11, 0.45) 100%),
          linear-gradient(180deg, rgba(5, 8, 11, 0.65), rgba(5, 8, 11, 0.2) 40%, rgba(5, 8, 11, 0.8));
      }
      .cube-body { position: relative; padding: 0; }

      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 14px 9px;
      }
      .head-text {
        font-family: 'AM Industry Inc', 'AM 72', sans-serif;
        letter-spacing: 0.2em;
        color: var(--am-muted);
        text-transform: uppercase;
      }
      .head-right { display: flex; align-items: center; gap: 8px; }
      .head-logo { width: auto; opacity: 0.9; }

      /* ── The strip ───────────────────────────────── */
      /* Near black, set apart, with the numbers upright and white. */
      .board {
        position: relative;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 10px;
        margin: 0 10px;
        padding: 14px 16px;
        border-radius: 10px;
        background: var(--am-board);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 10px 30px rgba(0, 0, 0, 0.5);
      }
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
      .team-dash,
      .clock {
        font-family: 'AM Industry Inc', 'Arial Narrow', system-ui, sans-serif;
        font-weight: 400;
        color: var(--am-ink);
        line-height: 0.92;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.01em;
      }
      .team-dash { color: var(--am-muted); }
      .middle { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .live-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--am-accent);
        box-shadow: 0 0 10px var(--am-accent);
        animation: blink 2s ease-in-out infinite;
      }
      @keyframes blink { 50% { opacity: 0.25; } }
      .clock.idle { color: var(--am-muted); }
      .clock.tenths { letter-spacing: 0.02em; }
      .kickoff {
        font-family: 'AM Industry Inc', 'Arial Narrow', system-ui, sans-serif;
        color: var(--am-ink);
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      .pips { display: flex; gap: 5px; }
      .pip {
        width: 16px;
        height: 5px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.14);
      }
      .pip.played { background: rgba(255, 255, 255, 0.4); }
      .pip.live { background: var(--am-accent); }

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
        .head { padding: clamp(9px, 1.5cqw, 26px) clamp(12px, 2cqw, 36px) clamp(8px, 1.2cqw, 20px); }
        .head-text { font-size: clamp(8px, 1.25cqw, 17px); }
        .head-logo { height: clamp(16px, 2.6cqw, 42px); }
        .board {
          margin: 0 clamp(8px, 1.4cqw, 26px);
          padding: clamp(12px, 2cqw, 38px) clamp(12px, 2.2cqw, 40px);
          border-radius: clamp(8px, 0.9cqw, 18px);
          gap: clamp(8px, 1.4cqw, 26px);
        }
        .core { gap: clamp(12px, 3cqw, 60px); }
        .team-code { font-size: clamp(10px, 1.7cqw, 26px); margin-bottom: clamp(3px, 0.5cqw, 10px); }
        .team-score, .team-dash { font-size: clamp(40px, 13cqw, 190px); }
        .clock { font-size: clamp(32px, 10.5cqw, 155px); }
        .kickoff { font-size: clamp(22px, 7cqw, 104px); }
        .live-dot {
          width: clamp(7px, 0.8cqw, 15px);
          height: clamp(7px, 0.8cqw, 15px);
        }
        .pip { width: clamp(13px, 1.8cqw, 34px); height: clamp(4px, 0.5cqw, 10px); }
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
