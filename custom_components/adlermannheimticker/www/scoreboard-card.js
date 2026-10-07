const CARD_VERSION = '7.0.0';

/* Period length in seconds. The API reports goal, penalty and ticker times as
   time elapsed inside the period, counting up from 00:00, which the two
   empty-net goals of a finished game confirm: they sit at 17:22 and 18:46 of
   the third. The arena board counts the same period down, so the card derives
   the remaining time from the elapsed value. */
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
  ES: 'Even Strength',
  PP: 'Powerplay',
  SH: 'Unterzahl',
  EN: 'Empty Net',
  PS: 'Penalty',
  SO: 'Shootout',
};

const DEFAULT_ENTITIES = {
  entity: 'sensor.adler_mannheim_current_game',
  entity_next: 'sensor.adler_mannheim_next_game',
  entity_last: 'sensor.adler_mannheim_last_game',
  entity_clock: 'sensor.adler_mannheim_clock',
  entity_stats: 'sensor.adler_mannheim_game_stats',
  entity_live: 'binary_sensor.adler_mannheim_game_live',
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

class AdlerMannheimScoreboard extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._expandedPanel = null;
    this._goalOverlay = null;
    this._goalOverlayPhase = 0;
    this._knownGoalCount = null;
    this._tickHandle = null;
    this._lastRenderSignature = '';
  }

  setConfig(config) {
    this._config = { ...DEFAULT_ENTITIES, ...(config || {}) };
  }

  static getStubConfig() {
    return { ...DEFAULT_ENTITIES };
  }

  getCardSize() {
    return 8;
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

  /* ── State access ────────────────────────────────── */

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

  /* ── Clock ───────────────────────────────────────── */

  /* The sensor is polled every few seconds, so the card carries the clock
     forward itself from the moment the state arrived. Without that the
     displayed time would jump in steps as wide as the poll interval. */
  _clock() {
    const clockState = this._state('entity_clock');
    if (!clockState) {
      return null;
    }

    const attrs = clockState.attributes || {};
    const elapsedAtUpdate = attrs.elapsed_seconds;
    const period = attrs.period || null;

    if (elapsedAtUpdate === null || elapsedAtUpdate === undefined) {
      return { period, elapsedInPeriod: null, remaining: null, source: attrs.source };
    }

    let drift = 0;
    if (attrs.running && clockState.last_updated) {
      drift = (Date.now() - new Date(clockState.last_updated).getTime()) / 1000;
      drift = Math.max(0, Math.min(drift, PERIOD_SECONDS));
    }

    const elapsedTotal = elapsedAtUpdate + drift;
    const elapsedInPeriod = Math.min(
      PERIOD_SECONDS,
      elapsedTotal - (period ? (period - 1) * PERIOD_SECONDS : 0),
    );

    return {
      period,
      elapsedInPeriod,
      remaining: PERIOD_SECONDS - elapsedInPeriod,
      source: attrs.source,
      interpolated: drift > 1,
    };
  }

  _startTicking() {
    if (this._tickHandle) {
      return;
    }
    this._tickHandle = window.setInterval(() => {
      const game = this._game();
      const needsClock = game && game.mode === 'live';
      const needsCountdown = game && game.mode === 'next';
      if (needsClock || needsCountdown || this._goalOverlay) {
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

  /* Repaint only the parts that move every second, so a running clock does
     not rebuild the whole card and kill the goal animation mid-flight. */
  _paintVolatile() {
    const clockNode = this.querySelector('[data-role="clock"]');
    if (clockNode) {
      const clock = this._clock();
      clockNode.textContent = clock && clock.remaining !== null
        ? formatSeconds(clock.remaining)
        : clockNode.textContent;
    }

    const countdownNodes = this.querySelectorAll('[data-countdown]');
    countdownNodes.forEach((node) => {
      node.textContent = this._countdown(node.getAttribute('data-countdown')) || '';
    });

    const penaltyBoxes = this.querySelectorAll('[data-role="penalties"]');
    if (penaltyBoxes.length) {
      const active = this._activePenalties();
      penaltyBoxes.forEach((node) => {
        const side = node.getAttribute('data-side');
        node.innerHTML = this._renderPenaltyBox(
          active.filter((entry) => (side === 'adler') === entry.isAdler),
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
      return 'jetzt';
    }
    const days = Math.floor(delta / 86400);
    delta -= days * 86400;
    const hours = Math.floor(delta / 3600);
    delta -= hours * 3600;
    const minutes = Math.floor(delta / 60);
    const seconds = delta - minutes * 60;

    if (days > 0) {
      return `${days}d ${hours}h ${pad(minutes)}m`;
    }
    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${pad(minutes)}:${pad(seconds)}`;
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
      const startSeconds = parseClockToSeconds(penalty.time);
      if (startSeconds === null) {
        return;
      }
      const minutes = PENALTY_MINUTES[penalty.minutes] || 2;
      const endSeconds = startSeconds + minutes * 60;
      if (clock.elapsedInPeriod < startSeconds || clock.elapsedInPeriod >= endSeconds) {
        return;
      }
      active.push({
        player: penalty.player,
        jersey: penalty.player_jersey,
        infraction: penalty.infraction,
        isAdler: Boolean(penalty.is_adler),
        remaining: endSeconds - clock.elapsedInPeriod,
      });
    });

    return active.sort((a, b) => a.remaining - b.remaining);
  }

  _renderPenaltyBox(entries) {
    if (!entries.length) {
      return '<div class="straf-empty">&ndash;&ndash;:&ndash;&ndash;</div>';
    }
    return entries
      .slice(0, 2)
      .map((entry) => `
        <div class="straf-entry">
          <span class="straf-jersey">#${escapeHtml(entry.jersey || '?')}</span>
          <span class="straf-clock">${formatSeconds(entry.remaining)}</span>
        </div>`)
      .join('');
  }

  /* ── Goal overlay ────────────────────────────────── */

  _detectNewGoal() {
    const game = this._game();
    if (!game || game.mode !== 'live') {
      this._knownGoalCount = null;
      this._goalOverlay = null;
      return;
    }

    const goals = (game.state.attributes || {}).goals || [];
    const adlerGoals = goals.filter((goal) => goal.is_adler_goal);

    if (this._knownGoalCount === null) {
      this._knownGoalCount = adlerGoals.length;
      return;
    }

    if (adlerGoals.length > this._knownGoalCount) {
      this._knownGoalCount = adlerGoals.length;
      this._goalOverlay = adlerGoals[adlerGoals.length - 1];
      this._goalOverlayPhase = 1;
      window.setTimeout(() => {
        this._goalOverlayPhase = 2;
        this._render();
      }, 3000);
      window.setTimeout(() => {
        this._goalOverlay = null;
        this._goalOverlayPhase = 0;
        this._render();
      }, 9000);
    }
  }

  /* ── Rendering ───────────────────────────────────── */

  _render() {
    const game = this._game();
    const signature = this._signature(game);
    if (signature === this._lastRenderSignature) {
      this._paintVolatile();
      return;
    }
    this._lastRenderSignature = signature;

    const body = game ? this._renderScoreboard(game) : this._renderStandby();

    this.innerHTML = `
      <ha-card>
        <style>${this._styles()}</style>
        ${this._goalOverlay ? this._renderGoalOverlay() : ''}
        ${body}
        ${this._renderDetails(game)}
      </ha-card>`;

    this.querySelectorAll('[data-panel]').forEach((node) => {
      node.addEventListener('click', () => {
        const panel = node.getAttribute('data-panel');
        this._expandedPanel = this._expandedPanel === panel ? null : panel;
        this._lastRenderSignature = '';
        this._render();
      });
    });

    this._paintVolatile();
  }

  _signature(game) {
    if (!game) {
      return 'standby';
    }
    const attrs = game.state.attributes || {};
    const stats = (this._state('entity_stats') || {}).attributes || {};
    return [
      game.mode,
      attrs.game_id,
      attrs.score_home,
      attrs.score_away,
      (attrs.goals || []).length,
      (attrs.penalties || []).length,
      stats.shots_adler,
      stats.shots_opponent,
      (this._clock() || {}).period,
      this._expandedPanel,
      this._goalOverlayPhase,
    ].join('|');
  }

  _renderStandby() {
    return `
      <div class="screen standby">
        <div class="panel">
          <div class="standby-text">KEINE SPIELDATEN</div>
        </div>
        <div class="led-ring"><span class="led-text">ADLER MANNHEIM</span></div>
      </div>`;
  }

  _renderGoalOverlay() {
    const goal = this._goalOverlay;
    const assists = [goal.assist1, goal.assist2].filter(Boolean).join(' · ');
    if (this._goalOverlayPhase === 1) {
      return `
        <div class="goal-overlay phase1">
          <div class="goal-shout">TOOOR!</div>
        </div>`;
    }
    return `
      <div class="goal-overlay phase2">
        ${goal.scorer_photo ? `<img class="goal-photo" src="${escapeHtml(goal.scorer_photo)}" alt="" onerror="this.remove()"/>` : ''}
        <div class="goal-scorer">#${escapeHtml(goal.scorer_jersey || '')} ${escapeHtml(goal.scorer || '')}</div>
        ${assists ? `<div class="goal-assists">Vorlage ${escapeHtml(assists)}</div>` : ''}
        <div class="goal-meta">${escapeHtml(goal.time || '')} · ${escapeHtml(GOAL_TYPE_LABELS[goal.type] || goal.type || '')}</div>
      </div>`;
  }

  _renderScoreboard(game) {
    const attrs = game.state.attributes || {};
    const stats = (this._state('entity_stats') || {}).attributes || {};
    const clock = this._clock();
    const isLive = game.mode === 'live';
    const isNext = game.mode === 'next';

    const homeShort = (attrs.home_team_short || (attrs.home_team || '???').slice(0, 3)).toUpperCase();
    const awayShort = (attrs.away_team_short || (attrs.away_team || '???').slice(0, 3)).toUpperCase();

    const periodScores = [];
    for (let index = 1; index <= 3; index += 1) {
      const value = attrs[`period_${index}`];
      periodScores.push(value ? value.split(':').map(Number) : null);
    }
    let periodLabel = clock && clock.period ? clock.period : 1;
    if (attrs.overtime) {
      periodScores.push(attrs.overtime.split(':').map(Number));
      periodLabel = 'V';
    }
    if (attrs.shootout) {
      periodLabel = 'P';
    }

    let clockText = 'ENDE';
    if (isLive) {
      clockText = clock && clock.remaining !== null ? formatSeconds(clock.remaining) : '--:--';
    } else if (isNext) {
      clockText = game.state.state || '';
    }

    const header = [
      attrs.competition_title || attrs.competition,
      attrs.matchday ? `${attrs.matchday}. Spieltag` : null,
      attrs.arena,
    ].filter(Boolean).join(' · ');

    return `
      <div class="screen ${game.mode}">
        ${header ? `<div class="board-header">${escapeHtml(header)}</div>` : ''}
        <div class="panel">
          <div class="row-top">
            <div class="straf-col">
              <div class="straf-title">STRAFZEIT</div>
              <div class="straf-box" data-role="penalties" data-side="${this._sideKey(attrs, 'home')}"></div>
            </div>
            <div class="clock-col">
              <div class="team-row">
                <span class="team-name">${escapeHtml(homeShort)}${this._rankBadge(attrs.rank_home)}</span>
                <span class="clock" data-role="clock">${escapeHtml(clockText)}</span>
                <span class="team-name">${escapeHtml(awayShort)}${this._rankBadge(attrs.rank_away)}</span>
              </div>
              ${isLive && clock ? `<div class="clock-source">${clock.source === 'ticker' ? 'Liveticker' : 'Drittel laut Spielstand'}</div>` : ''}
            </div>
            <div class="straf-col">
              <div class="straf-title">STRAFZEIT</div>
              <div class="straf-box" data-role="penalties" data-side="${this._sideKey(attrs, 'away')}"></div>
            </div>
          </div>

          <div class="row-score">
            <div class="pblocks-col">${this._renderBlocks(periodScores, 0)}</div>
            <div class="score-col">
              ${isNext
                ? '<div class="future-vs">VS</div>'
                : `<div class="score-display">
                     <span class="score-digit">${escapeHtml(attrs.score_home ?? 0)}</span>
                     <span class="period-circle ${isLive ? 'active' : ''}">${escapeHtml(periodLabel)}</span>
                     <span class="score-digit">${escapeHtml(attrs.score_away ?? 0)}</span>
                   </div>`}
            </div>
            <div class="pblocks-col">${this._renderBlocks(periodScores, 1)}</div>
          </div>

          ${isLive || game.mode === 'final' ? this._renderShotRow(attrs, stats) : ''}
          ${isLive ? this._renderLastGoal(attrs) : ''}
        </div>
        <div class="led-ring ${isLive ? 'glow' : ''}">
          <span class="led-text">${escapeHtml(attrs.home_team || '')} vs ${escapeHtml(attrs.away_team || '')}</span>
        </div>
      </div>`;
  }

  /* The penalty boxes sit left and right of the clock, home on the left. The
     box therefore needs to know which of the two sides is Adler. */
  _sideKey(attrs, position) {
    const adlerIsHome = attrs.is_home === true;
    if (position === 'home') {
      return adlerIsHome ? 'adler' : 'opponent';
    }
    return adlerIsHome ? 'opponent' : 'adler';
  }

  _rankBadge(rank) {
    if (!rank) {
      return '';
    }
    return `<span class="rank-badge">${escapeHtml(rank)}.</span>`;
  }

  _renderBlocks(periodScores, teamIndex) {
    const count = Math.max(periodScores.length, 3);
    let html = '';
    for (let index = 0; index < count && index < 4; index += 1) {
      const entry = periodScores[index];
      const value = entry ? entry[teamIndex] : null;
      html += `
        <div class="led-block ${entry ? 'on' : 'off'}">
          <span class="led-val">${value !== null && value !== undefined ? escapeHtml(value) : ''}</span>
        </div>`;
    }
    return html;
  }

  _renderShotRow(attrs, stats) {
    if (stats.shots_adler === undefined) {
      return '';
    }
    const adlerIsHome = attrs.is_home === true;
    const homeShots = adlerIsHome ? stats.shots_adler : stats.shots_opponent;
    const awayShots = adlerIsHome ? stats.shots_opponent : stats.shots_adler;
    return `
      <div class="shot-row">
        <span class="shot-val">${escapeHtml(homeShots ?? 0)}</span>
        <span class="shot-label">SCHÜSSE AUFS TOR</span>
        <span class="shot-val">${escapeHtml(awayShots ?? 0)}</span>
      </div>`;
  }

  _renderLastGoal(attrs) {
    const goals = attrs.goals || [];
    if (!goals.length) {
      return '';
    }
    const goal = goals[goals.length - 1];
    if (!goal.scorer) {
      return '';
    }
    const assists = [goal.assist1, goal.assist2].filter(Boolean).join(', ');
    return `
      <div class="ticker ${goal.is_adler_goal ? 'adler' : 'opponent'}">
        <strong>${escapeHtml(goal.scorer)}</strong>${assists ? ` · ${escapeHtml(assists)}` : ''}
        <span class="ticker-time">P${escapeHtml(goal.period || '')} ${escapeHtml(goal.time || '')}</span>
      </div>`;
  }

  /* ── Detail panels ───────────────────────────────── */

  _renderDetails(game) {
    const next = this._state('entity_next');
    const last = this._state('entity_last');
    if (!next && !last) {
      return '';
    }

    const cards = [];
    if (next && next.attributes.game_id) {
      cards.push(this._renderNextCard(next));
    }
    if (last && last.attributes.game_id) {
      cards.push(this._renderLastCard(last));
    }

    let expanded = '';
    if (this._expandedPanel === 'next' && next) {
      expanded = this._renderNextExpanded(next.attributes);
    } else if (this._expandedPanel === 'last' && last) {
      expanded = this._renderTimeline(last.attributes);
    } else if (this._expandedPanel === 'stats') {
      expanded = this._renderStatsExpanded(game);
    }

    return `
      <div class="details">
        <div class="info-row">${cards.join('')}${this._renderStatsCard()}</div>
        ${expanded}
      </div>`;
  }

  _renderNextCard(state) {
    const attrs = state.attributes;
    const expanded = this._expandedPanel === 'next';
    return `
      <div class="info-card clickable ${expanded ? 'expanded' : ''}" data-panel="next">
        <div class="info-label">NÄCHSTES SPIEL <span class="expand-icon">${expanded ? '▲' : '▼'}</span></div>
        <div class="info-opponent">${escapeHtml(attrs.opponent || '?')}</div>
        <div class="info-meta">${escapeHtml(state.state || '')} · ${attrs.is_home ? 'Heim' : 'Auswärts'}</div>
        <div class="cd-time" data-countdown="${escapeHtml(attrs.match_start_iso || '')}"></div>
      </div>`;
  }

  _renderLastCard(state) {
    const attrs = state.attributes;
    const expanded = this._expandedPanel === 'last';
    return `
      <div class="info-card clickable ${expanded ? 'expanded' : ''}" data-panel="last">
        <div class="info-label">LETZTES SPIEL <span class="expand-icon">${expanded ? '▲' : '▼'}</span></div>
        <div class="info-opponent">${escapeHtml(attrs.opponent || '?')}</div>
        <div class="last-score">${escapeHtml(attrs.score_home ?? 0)} : ${escapeHtml(attrs.score_away ?? 0)}</div>
        <div class="info-meta">${escapeHtml(attrs.match_start || '')} · ${attrs.is_home ? 'Heim' : 'Auswärts'}</div>
      </div>`;
  }

  _renderStatsCard() {
    const stats = this._state('entity_stats');
    if (!stats || stats.attributes.shots_adler === undefined) {
      return '';
    }
    const expanded = this._expandedPanel === 'stats';
    const attrs = stats.attributes;
    return `
      <div class="info-card clickable ${expanded ? 'expanded' : ''}" data-panel="stats">
        <div class="info-label">STATISTIK <span class="expand-icon">${expanded ? '▲' : '▼'}</span></div>
        <div class="info-opponent">${escapeHtml(attrs.shots_adler ?? 0)} : ${escapeHtml(attrs.shots_opponent ?? 0)}</div>
        <div class="info-meta">Schüsse · PP ${escapeHtml(attrs.powerplay_adler || '0/0')}</div>
      </div>`;
  }

  _renderNextExpanded(attrs) {
    const rows = [
      ['Anpfiff', attrs.match_start],
      ['Wettbewerb', attrs.competition_title || attrs.competition],
      ['Spieltag', attrs.matchday],
      ['Ort', attrs.arena || (attrs.is_home ? 'SAP Arena' : 'Auswärts')],
      ['Tabellenplatz', attrs.rank_adler ? `${attrs.rank_adler}. gegen ${attrs.rank_opponent || '?'}.` : null],
    ].filter((row) => row[1]);

    return `
      <div class="expanded-panel">
        <div class="exp-matchup">
          <div class="exp-team">
            ${attrs.home_logo ? `<img class="exp-logo" src="${escapeHtml(attrs.home_logo)}" alt="" onerror="this.remove()"/>` : ''}
            <span class="exp-tname">${escapeHtml(attrs.home_team || '?')}</span>
          </div>
          <div class="exp-vs">VS</div>
          <div class="exp-team">
            ${attrs.away_logo ? `<img class="exp-logo" src="${escapeHtml(attrs.away_logo)}" alt="" onerror="this.remove()"/>` : ''}
            <span class="exp-tname">${escapeHtml(attrs.away_team || '?')}</span>
          </div>
        </div>
        <div class="exp-grid">
          ${rows.map(([key, value]) => `
            <div class="exp-item">
              <span class="exp-key">${escapeHtml(key)}</span>
              <span class="exp-val">${escapeHtml(value)}</span>
            </div>`).join('')}
          <div class="exp-item">
            <span class="exp-key">Countdown</span>
            <span class="exp-val" data-countdown="${escapeHtml(attrs.match_start_iso || '')}"></span>
          </div>
        </div>
        ${attrs.link_ticketing ? `<a class="exp-link" href="${escapeHtml(attrs.link_ticketing)}" target="_blank" rel="noopener">Tickets</a>` : ''}
      </div>`;
  }

  _renderStatsExpanded(game) {
    const stats = this._state('entity_stats');
    if (!stats) {
      return '';
    }
    const attrs = stats.attributes;
    const rows = [
      ['Schüsse aufs Tor', attrs.shots_adler, attrs.shots_opponent],
      ['Schüsse daneben', attrs.shots_missed_adler, attrs.shots_missed_opponent],
      ['Bully gewonnen %', attrs.faceoff_pct_adler, attrs.faceoff_pct_opponent],
      ['Powerplay', attrs.powerplay_adler, attrs.powerplay_opponent],
      ['Strafminuten', attrs.pim_adler, attrs.pim_opponent],
      ['Paraden', attrs.saves_adler, attrs.saves_opponent],
    ];

    const meta = [
      attrs.arena,
      attrs.attendance ? `${attrs.attendance.toLocaleString('de-DE')} Zuschauer` : null,
      (attrs.officials || []).length
        ? `Schiedsrichter ${attrs.officials.filter((o) => o.role && o.role.startsWith('referee')).map((o) => o.name).join(', ')}`
        : null,
    ].filter(Boolean).join(' · ');

    return `
      <div class="expanded-panel">
        <div class="cmp-head"><span>ADLER</span><span></span><span>GEGNER</span></div>
        ${rows.map(([label, adler, opponent]) => this._renderCompareRow(label, adler, opponent)).join('')}
        ${meta ? `<div class="cmp-meta">${escapeHtml(meta)}</div>` : ''}
      </div>`;
  }

  _renderCompareRow(label, adler, opponent) {
    const adlerNumber = Number(String(adler).split('/')[0]) || 0;
    const opponentNumber = Number(String(opponent).split('/')[0]) || 0;
    const total = adlerNumber + opponentNumber;
    const share = total ? Math.round((adlerNumber / total) * 100) : 50;
    return `
      <div class="cmp-row">
        <span class="cmp-val">${escapeHtml(adler ?? '0')}</span>
        <span class="cmp-bar-wrap">
          <span class="cmp-label">${escapeHtml(label)}</span>
          <span class="cmp-bar"><span class="cmp-fill" style="width:${share}%"></span></span>
        </span>
        <span class="cmp-val">${escapeHtml(opponent ?? '0')}</span>
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
        isAdler: goal.is_adler_goal,
        title: goal.scorer,
        subtitle: [goal.assist1, goal.assist2].filter(Boolean).join(', '),
        badge: GOAL_TYPE_LABELS[goal.type] || goal.type,
        score: `${goal.score_home ?? ''}:${goal.score_away ?? ''}`,
      });
    });
    (attrs.penalties || []).forEach((penalty) => {
      events.push({
        kind: 'penalty',
        period: penalty.period || 0,
        seconds: parseClockToSeconds(penalty.time) || 0,
        time: penalty.time,
        isAdler: penalty.is_adler,
        title: penalty.player,
        subtitle: penalty.infraction,
        badge: penalty.minutes,
      });
    });

    if (!events.length) {
      return '<div class="expanded-panel"><div class="cmp-meta">Keine Ereignisse</div></div>';
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
      <div class="tl-period">
        <div class="tl-period-head">${period ? `${period}. Drittel` : 'Sonstige'}</div>
        ${entries.map((event) => `
          <div class="tl-event ${event.kind} ${event.isAdler ? 'adler' : 'opponent'}">
            <span class="tl-time">${escapeHtml(event.time || '')}</span>
            <span class="tl-icon">${event.kind === 'goal' ? '●' : '▮'}</span>
            <span class="tl-body">
              <span class="tl-title">${escapeHtml(event.title || '')}${event.score ? ` <em>${escapeHtml(event.score)}</em>` : ''}</span>
              ${event.subtitle ? `<span class="tl-sub">${escapeHtml(event.subtitle)}</span>` : ''}
            </span>
            ${event.badge ? `<span class="tl-badge">${escapeHtml(event.badge)}</span>` : ''}
          </div>`).join('')}
      </div>`).join('');

    return `<div class="expanded-panel timeline">${blocks}</div>`;
  }

  /* ── Styles ──────────────────────────────────────── */

  _styles() {
    return `
      :host { display: block; }
      ha-card {
        position: relative;
        overflow: hidden;
        background: linear-gradient(160deg, #0a1628 0%, #06101d 100%);
        color: #e8eef7;
        border: none;
        padding: 0;
      }
      .screen { padding: 12px; }
      .board-header {
        text-align: center;
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #7f93ad;
        margin-bottom: 8px;
      }
      .panel {
        background: #04080f;
        border: 2px solid #16283f;
        border-radius: 10px;
        padding: 12px 10px;
      }
      .row-top {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 8px;
        align-items: start;
      }
      .straf-col { text-align: center; min-width: 64px; }
      .straf-title {
        font-size: 8px;
        letter-spacing: 0.1em;
        color: #5f7794;
        margin-bottom: 4px;
      }
      .straf-box {
        min-height: 34px;
        background: #0b1626;
        border: 1px solid #1d3350;
        border-radius: 6px;
        padding: 3px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        justify-content: center;
      }
      .straf-empty { font-family: monospace; font-size: 12px; color: #2f4663; }
      .straf-entry {
        display: flex;
        justify-content: space-between;
        gap: 4px;
        font-family: monospace;
        font-size: 11px;
      }
      .straf-jersey { color: #8aa3c0; }
      .straf-clock { color: #ffd34d; font-weight: 700; }
      .clock-col { text-align: center; }
      .team-row {
        display: flex;
        align-items: baseline;
        gap: 10px;
        justify-content: center;
      }
      .team-name {
        font-size: 15px;
        font-weight: 800;
        letter-spacing: 0.06em;
        color: #cfe0f3;
        white-space: nowrap;
      }
      .rank-badge {
        font-size: 9px;
        font-weight: 600;
        color: #6f87a5;
        margin-left: 3px;
        vertical-align: super;
      }
      .clock {
        font-family: 'DSEG7', monospace;
        font-size: 26px;
        font-weight: 700;
        color: #ff4d4d;
        text-shadow: 0 0 12px rgba(255, 77, 77, 0.55);
        min-width: 94px;
        display: inline-block;
      }
      .clock-source {
        font-size: 8px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #4e687f;
        margin-top: 2px;
      }
      .row-score {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 8px;
        align-items: center;
        margin-top: 10px;
      }
      .pblocks-col { display: flex; gap: 4px; justify-content: center; }
      .led-block {
        width: 22px;
        height: 30px;
        border-radius: 4px;
        display: grid;
        place-items: center;
        border: 1px solid #1d3350;
      }
      .led-block.on { background: #10243c; }
      .led-block.off { background: #070e18; }
      .led-val { font-family: monospace; font-size: 14px; color: #ffcf3d; }
      .score-display { display: flex; align-items: center; gap: 10px; }
      .score-digit {
        font-family: monospace;
        font-size: 46px;
        font-weight: 700;
        line-height: 1;
        color: #ffffff;
        text-shadow: 0 0 16px rgba(120, 180, 255, 0.35);
      }
      .period-circle {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid #2b4466;
        display: grid;
        place-items: center;
        font-size: 13px;
        font-weight: 700;
        color: #9fb8d4;
      }
      .period-circle.active {
        border-color: #ff4d4d;
        color: #ff8080;
        animation: pulse 2s ease-in-out infinite;
      }
      @keyframes pulse { 50% { opacity: 0.45; } }
      .future-vs {
        font-size: 24px;
        font-weight: 800;
        color: #4a6885;
        letter-spacing: 0.1em;
      }
      .shot-row {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid #16283f;
      }
      .shot-val { font-family: monospace; font-size: 15px; color: #8fd0ff; text-align: center; }
      .shot-label { font-size: 9px; letter-spacing: 0.1em; color: #5f7794; }
      .ticker {
        margin-top: 8px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 12px;
        background: #0d1d31;
        border-left: 3px solid #2b4466;
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .ticker.adler { border-left-color: #ff4d4d; }
      .ticker-time { font-family: monospace; color: #7f93ad; white-space: nowrap; }
      .led-ring {
        margin-top: 8px;
        text-align: center;
        padding: 4px;
        border-radius: 6px;
        background: #04080f;
        border: 1px solid #16283f;
      }
      .led-ring.glow { border-color: #ff4d4d; box-shadow: 0 0 14px rgba(255, 77, 77, 0.25); }
      .led-text {
        font-size: 9px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #6f87a5;
      }
      .standby { text-align: center; }
      .standby-text {
        padding: 28px 0;
        font-size: 13px;
        letter-spacing: 0.18em;
        color: #3d5570;
      }
      .details { padding: 0 12px 12px; }
      .info-row { display: flex; gap: 8px; flex-wrap: wrap; }
      .info-card {
        flex: 1 1 140px;
        background: #0b1626;
        border: 1px solid #16283f;
        border-radius: 8px;
        padding: 8px 10px;
      }
      .info-card.clickable { cursor: pointer; }
      .info-card.expanded { border-color: #2b4466; }
      .info-label {
        font-size: 8px;
        letter-spacing: 0.12em;
        color: #5f7794;
        display: flex;
        justify-content: space-between;
      }
      .info-opponent { font-size: 13px; font-weight: 700; margin-top: 3px; }
      .info-meta { font-size: 10px; color: #7f93ad; margin-top: 2px; }
      .last-score { font-family: monospace; font-size: 18px; color: #ffcf3d; margin-top: 2px; }
      .cd-time { font-family: monospace; font-size: 12px; color: #8fd0ff; margin-top: 3px; }
      .expanded-panel {
        margin-top: 8px;
        background: #0b1626;
        border: 1px solid #16283f;
        border-radius: 8px;
        padding: 10px;
      }
      .exp-matchup {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 8px;
      }
      .exp-team { display: flex; flex-direction: column; align-items: center; gap: 4px; }
      .exp-logo { width: 40px; height: 40px; object-fit: contain; }
      .exp-tname { font-size: 11px; text-align: center; color: #cfe0f3; }
      .exp-vs { font-size: 12px; color: #4a6885; letter-spacing: 0.1em; }
      .exp-grid {
        margin-top: 10px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 6px;
      }
      .exp-item { display: flex; flex-direction: column; }
      .exp-key { font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase; color: #5f7794; }
      .exp-val { font-size: 12px; color: #e8eef7; }
      .exp-link {
        display: inline-block;
        margin-top: 8px;
        font-size: 11px;
        color: #8fd0ff;
        text-decoration: none;
      }
      .cmp-head {
        display: grid;
        grid-template-columns: 38px 1fr 38px;
        font-size: 8px;
        letter-spacing: 0.12em;
        color: #5f7794;
        margin-bottom: 6px;
      }
      .cmp-head span:last-child { text-align: right; }
      .cmp-row {
        display: grid;
        grid-template-columns: 38px 1fr 38px;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
      }
      .cmp-val { font-family: monospace; font-size: 12px; color: #e8eef7; }
      .cmp-row .cmp-val:last-child { text-align: right; }
      .cmp-bar-wrap { display: flex; flex-direction: column; gap: 3px; }
      .cmp-label { font-size: 9px; color: #7f93ad; text-align: center; }
      .cmp-bar { height: 5px; background: #16283f; border-radius: 3px; overflow: hidden; }
      .cmp-fill { display: block; height: 100%; background: linear-gradient(90deg, #ff4d4d, #ff8a3d); }
      .cmp-meta { font-size: 9px; color: #5f7794; margin-top: 6px; text-align: center; }
      .timeline { max-height: 340px; overflow-y: auto; }
      .tl-period { margin-bottom: 10px; }
      .tl-period-head {
        font-size: 8px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #5f7794;
        border-bottom: 1px solid #16283f;
        padding-bottom: 3px;
        margin-bottom: 5px;
      }
      .tl-event {
        display: grid;
        grid-template-columns: 38px 12px 1fr auto;
        align-items: center;
        gap: 6px;
        padding: 3px 0;
      }
      .tl-time { font-family: monospace; font-size: 10px; color: #7f93ad; }
      .tl-icon { font-size: 9px; color: #3d5570; }
      .tl-event.adler .tl-icon { color: #ff4d4d; }
      .tl-body { display: flex; flex-direction: column; }
      .tl-title { font-size: 11px; color: #e8eef7; }
      .tl-title em { font-family: monospace; color: #ffcf3d; font-style: normal; }
      .tl-sub { font-size: 9px; color: #7f93ad; }
      .tl-badge {
        font-size: 8px;
        padding: 1px 5px;
        border-radius: 8px;
        background: #16283f;
        color: #9fb8d4;
        white-space: nowrap;
      }
      .goal-overlay {
        position: absolute;
        inset: 0;
        z-index: 5;
        display: grid;
        place-items: center;
        text-align: center;
        background: rgba(4, 8, 15, 0.94);
        animation: fadein 0.25s ease-out;
      }
      @keyframes fadein { from { opacity: 0; } }
      .goal-shout {
        font-size: 42px;
        font-weight: 900;
        letter-spacing: 0.08em;
        color: #ff4d4d;
        text-shadow: 0 0 26px rgba(255, 77, 77, 0.7);
        animation: shout 0.7s ease-in-out infinite alternate;
      }
      @keyframes shout { to { transform: scale(1.08); } }
      .goal-photo { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; }
      .goal-scorer { font-size: 20px; font-weight: 800; margin-top: 8px; }
      .goal-assists { font-size: 12px; color: #9fb8d4; margin-top: 3px; }
      .goal-meta { font-size: 10px; color: #7f93ad; margin-top: 5px; }
      @media (max-width: 420px) {
        .score-digit { font-size: 34px; }
        .clock { font-size: 20px; min-width: 74px; }
        .led-block { width: 18px; height: 26px; }
        .straf-col { min-width: 52px; }
      }`;
  }
}

customElements.define('adler-mannheim-scoreboard', AdlerMannheimScoreboard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'adler-mannheim-scoreboard',
  name: 'Adler Mannheim Scoreboard',
  description: `Anzeigetafel mit Live-Spieluhr, Strafzeiten und Statistik (v${CARD_VERSION})`,
  preview: false,
});
