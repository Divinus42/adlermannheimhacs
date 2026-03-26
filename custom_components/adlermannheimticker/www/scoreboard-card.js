const CARD_VERSION = '5.1.0';

class AdlerMannheimScoreboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._countdownTimer = null;
    this._lastGoalCount = -1;       // for goal alert detection
    this._goalAlertTimeout = null;
    this._showingAlert = false;
    this._alertGoal = null;
  }

  setConfig(config) {
    this._config = {
      entity: config.entity || null,
      entity_next: config.entity_next || null,
      entity_last: config.entity_last || null,
      ...config,
    };
    this._entityPatterns = {
      entity: ['sensor.adler_mannheim_current_game', 'sensor.adler_mannheim_aktuelles_spiel'],
      entity_next: ['sensor.adler_mannheim_next_game', 'sensor.adler_mannheim_nachstes_spiel', 'sensor.adler_mannheim_na_chstes_spiel'],
      entity_last: ['sensor.adler_mannheim_last_game', 'sensor.adler_mannheim_letztes_spiel'],
    };
  }

  connectedCallback() { this._startCountdown(); }
  disconnectedCallback() { this._stopCountdown(); this._clearGoalAlert(); }

  _startCountdown() {
    this._stopCountdown();
    this._countdownTimer = setInterval(() => {
      const el = this.shadowRoot && this.shadowRoot.querySelector('.cd-time');
      if (el && el.dataset.iso) el.textContent = this._calcCountdown(el.dataset.iso);
    }, 30000);
  }
  _stopCountdown() { if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; } }

  _clearGoalAlert() {
    if (this._goalAlertTimeout) { clearTimeout(this._goalAlertTimeout); this._goalAlertTimeout = null; }
    this._showingAlert = false;
    this._alertGoal = null;
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;

    // Detect changes across ALL adler_mannheim sensors
    let changed = !prev;
    if (!changed) {
      for (const id of Object.keys(hass.states)) {
        if (!id.startsWith('sensor.adler_mannheim')) continue;
        const o = prev.states[id]; const n = hass.states[id];
        if (!o && !n) continue;
        if (!o || !n) { changed = true; break; }
        if (o.state !== n.state || o.last_updated !== n.last_updated) { changed = true; break; }
      }
    }

    if (changed) {
      this._discovered = null; // clear cache
      this._detectGoalAlert();
      this._render();
    }
  }

  getCardSize() { return 7; }
  static getStubConfig() { return { entity: 'sensor.adler_mannheim_aktuelles_spiel' }; }

  /* ── Entity helpers ── */
  _isValidState(s) {
    return s && s.state && !['None', 'unavailable', 'unknown', 'none'].includes(s.state);
  }

  /**
   * Find all Adler Mannheim sensor entities by scanning hass.states.
   * Caches result per render cycle. Categorizes by 'status' attribute.
   */
  _discoverEntities() {
    if (this._discovered) return this._discovered;

    const found = { live: null, final: null, future: null };

    // 1. Try explicit config first
    for (const [key, statusKey] of [['entity','live'], ['entity_next','future'], ['entity_last','final']]) {
      if (this._config[key]) {
        const s = this._hass.states[this._config[key]];
        if (this._isValidState(s)) found[statusKey] = s;
      }
    }

    // 2. Try known ID patterns
    for (const [key, statusKey] of [['entity','live'], ['entity_next','future'], ['entity_last','final']]) {
      if (found[statusKey]) continue;
      for (const id of (this._entityPatterns[key] || [])) {
        const s = this._hass.states[id];
        if (this._isValidState(s)) { found[statusKey] = s; break; }
      }
    }

    // 3. Fallback: scan ALL states for adler_mannheim sensors by status attribute
    if (!found.live || !found.final || !found.future) {
      for (const [id, s] of Object.entries(this._hass.states)) {
        if (!id.startsWith('sensor.adler_mannheim')) continue;
        if (!this._isValidState(s)) continue;
        const status = (s.attributes.status || '').toUpperCase();
        if (!found.live && status === 'LIVE') found.live = s;
        else if (!found.future && status === 'FUTURE') found.future = s;
        else if (!found.final && status === 'FINAL') found.final = s;
      }
    }

    this._discovered = found;
    return found;
  }

  _getMainGame() {
    this._discovered = null; // reset cache for this render
    const e = this._discoverEntities();

    if (e.live) return { state: e.live, mode: 'live' };
    if (e.future) return { state: e.future, mode: 'next' };
    if (e.final) return { state: e.final, mode: 'result' };
    return null;
  }

  _calcCountdown(iso) {
    if (!iso) return '';
    const diff = new Date(iso) - new Date();
    if (diff <= 0) return 'JETZT';
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (d > 0) return `${d}T ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /* ══════════════════════════════════════
     GOAL ALERT DETECTION
     ══════════════════════════════════════ */
  _detectGoalAlert() {
    const e = this._discoverEntities();
    const cur = e.live;
    if (!cur) {
      // No live game — reset everything
      this._lastGoalCount = -1;
      if (this._showingAlert) this._clearGoalAlert();
      return;
    }
    const goals = cur.attributes.goals || [];
    const count = goals.length;

    // First load: seed, don't alert
    if (this._lastGoalCount === -1) { this._lastGoalCount = count; return; }

    if (count > this._lastGoalCount) {
      // Check all new goals (there could be more than one if poll was slow)
      for (let i = this._lastGoalCount; i < count; i++) {
        const goal = goals[i];
        if (goal.is_adler_goal) {
          this._lastGoalCount = count;
          this._triggerGoalAlert(goal, cur.attributes);
          return; // show the latest Adler goal
        }
      }
      this._lastGoalCount = count;
    } else {
      this._lastGoalCount = count;
    }
  }

  _triggerGoalAlert(goal, gameAttrs) {
    this._clearGoalAlert();
    this._showingAlert = true;
    this._alertGoal = { ...goal, home_team: gameAttrs.home_team, away_team: gameAttrs.away_team,
      score_home: gameAttrs.score_home, score_away: gameAttrs.score_away };

    // Phase 1: "TOOOR!" for 3 seconds, then Phase 2: scorer for 6 seconds
    this._render();

    this._goalAlertTimeout = setTimeout(() => {
      // Transition to phase 2 (scorer)
      const overlay = this.shadowRoot.querySelector('.goal-overlay');
      if (overlay) {
        overlay.classList.remove('phase1');
        overlay.classList.add('phase2');
      }

      this._goalAlertTimeout = setTimeout(() => {
        // Dismiss
        this._showingAlert = false;
        this._alertGoal = null;
        this._render();
      }, 6000);
    }, 3000);
  }

  /* ── Main render ── */
  _render() {
    if (!this._hass) return;
    const main = this._getMainGame();

    this.shadowRoot.innerHTML = `
      <ha-card>
        <style>${STYLES}</style>
        <div class="cube">
          ${main ? this._renderScoreboard(main) : this._renderStandby()}
          ${this._renderDetails(main)}
          ${this._showingAlert ? this._renderGoalOverlay() : ''}
        </div>
      </ha-card>`;
  }

  /* ══════════════════════════════════════
     GOAL ALERT OVERLAY
     ══════════════════════════════════════ */
  _renderGoalOverlay() {
    const g = this._alertGoal;
    if (!g) return '';
    const scorer = g.scorer || 'TOR';
    const jersey = g.scorer_jersey ? `#${g.scorer_jersey}` : '';
    const photo = g.scorer_photo || '';
    const assists = [g.assist1, g.assist2].filter(Boolean).join(', ');
    const score = `${g.score_home ?? '?'} : ${g.score_away ?? '?'}`;

    return `
      <div class="goal-overlay phase1">
        <!-- Phase 1: TOOOR! -->
        <div class="alert-phase1">
          <div class="alert-siren">&#x1F6A8;</div>
          <div class="alert-tor">TOOOR!</div>
          <div class="alert-score">${score}</div>
        </div>
        <!-- Phase 2: Scorer details -->
        <div class="alert-phase2">
          ${photo ? `<img class="alert-photo" src="${photo}" alt="${scorer}" onerror="this.style.display='none'"/>` : ''}
          <div class="alert-info">
            <div class="alert-label">TORSCHÜTZE</div>
            <div class="alert-name">${scorer}</div>
            ${jersey ? `<div class="alert-jersey">${jersey}</div>` : ''}
            ${assists ? `<div class="alert-assists">Assists: ${assists}</div>` : ''}
            <div class="alert-time">${g.time || ''} · ${g.period ? g.period + '. Drittel' : ''}</div>
            <div class="alert-score2">${score}</div>
          </div>
        </div>
      </div>`;
  }

  _renderStandby() {
    return `
      <div class="screen standby">
        <div class="panel"><div class="standby-text">KEINE SPIELDATEN</div></div>
        <div class="led-ring"><span class="led-text">ADLER MANNHEIM.DE</span></div>
      </div>`;
  }

  /* ══════════════════════════════════════
     SCOREBOARD
     ══════════════════════════════════════ */
  _renderScoreboard({ state, mode }) {
    const a = state.attributes;
    const isLive = mode === 'live';
    const isNext = mode === 'next';
    const homeScore = a.score_home ?? 0;
    const awayScore = a.score_away ?? 0;
    const homeShort = (a.home_team_short || (a.home_team || '???').substring(0, 3)).toUpperCase();
    const awayShort = (a.away_team_short || (a.away_team || '???').substring(0, 3)).toUpperCase();

    let currentPeriod = 1;
    if (a.period_3) currentPeriod = 3;
    else if (a.period_2) currentPeriod = 3;
    else if (a.period_1) currentPeriod = 2;
    if (a.overtime) currentPeriod = 4;
    if (isLive && a.goals && a.goals.length > 0) {
      const lp = a.goals[a.goals.length - 1].period;
      if (lp && lp > currentPeriod) currentPeriod = lp;
    }

    const pScores = [];
    for (let i = 1; i <= 3; i++) {
      const p = a[`period_${i}`];
      if (p) { const [h, aw] = p.split(':').map(Number); pScores.push([h, aw]); }
      else pScores.push(null);
    }
    let hasOT = false;
    if (a.overtime) { const [h, aw] = a.overtime.split(':').map(Number); pScores.push([h, aw]); hasOT = true; }

    return `
      <div class="screen ${mode}">
        <div class="panel">
          <div class="row-top">
            <div class="straf-col"><div class="straf-title">STRAFZEIT</div><div class="straf-box"></div></div>
            <div class="clock-col"><div class="team-row">
              <span class="team-name home-c">${homeShort}</span>
              <span class="clock">${isLive ? '20:00' : isNext ? (state.state || '') : 'ENDE'}</span>
              <span class="team-name away-c">${awayShort}</span>
            </div></div>
            <div class="straf-col"><div class="straf-title">STRAFZEIT</div><div class="straf-box"></div></div>
          </div>
          <div class="row-score">
            <div class="pblocks-col">${this._renderBlocks(pScores, 0)}</div>
            <div class="score-col">
              ${isNext ? '<div class="future-vs">VS</div>'
                : `<div class="score-display">
                     <span class="score-digit">${homeScore}</span>
                     <span class="period-circle ${isLive ? 'active' : ''}">${hasOT ? 'V' : currentPeriod}</span>
                     <span class="score-digit">${awayScore}</span>
                   </div>`}
            </div>
            <div class="pblocks-col">${this._renderBlocks(pScores, 1)}</div>
          </div>
          ${isLive ? this._renderGoalTicker(a) : ''}
        </div>
        <div class="led-ring ${isLive ? 'glow' : ''}"><span class="led-text">ADLER MANNHEIM.DE</span></div>
      </div>`;
  }

  _renderBlocks(pScores, teamIdx) {
    const side = teamIdx === 0 ? 'home' : 'away';
    let html = '';
    const count = Math.max(pScores.length, 3);
    for (let i = 0; i < count && i < 4; i++) {
      const p = pScores[i]; const val = p ? p[teamIdx] : null; const on = p !== null;
      html += `<div class="led-block ${side} ${on ? 'on' : 'off'}"><span class="led-val">${val !== null ? val : ''}</span></div>`;
    }
    return html;
  }

  _renderGoalTicker(a) {
    const goals = a.goals;
    if (!goals || !goals.length) return '';
    const g = goals[goals.length - 1];
    if (!g.scorer) return '';
    const assists = [g.assist1, g.assist2].filter(Boolean).join(', ');
    return `<div class="ticker">&#x1F6A8; <strong>${g.scorer}</strong>${assists ? ` · ${assists}` : ''} <span class="ticker-time">${g.time || ''}</span></div>`;
  }

  /* ══════════════════════════════════════
     DETAILS PANEL
     ══════════════════════════════════════ */
  _renderDetails(main) {
    const e = this._discoverEntities();
    const nextEntity = e.future;
    const lastEntity = e.final;

    let goalsHtml = '';
    const gameWithGoals = main ? main.state : null;
    if (gameWithGoals && gameWithGoals.attributes.goals && gameWithGoals.attributes.goals.length > 0) {
      goalsHtml = this._renderGoalList(gameWithGoals.attributes);
    }

    let nextHtml = '';
    if (nextEntity) nextHtml = this._renderNextGame(nextEntity.attributes, nextEntity.state);

    let lastHtml = '';
    if (lastEntity && main && main.mode !== 'result') lastHtml = this._renderLastGame(lastEntity.attributes);

    if (!goalsHtml && !nextHtml && !lastHtml) return '';

    return `
      <div class="details">
        ${goalsHtml}
        <div class="info-row">${nextHtml}${lastHtml}</div>
      </div>`;
  }

  _renderGoalList(a) {
    const goals = a.goals || [];
    if (!goals.length) return '';
    const rows = goals.map(g => {
      const scorer = g.scorer || '?';
      const assists = [g.assist1, g.assist2].filter(Boolean).join(', ');
      const typeLabel = {'PP':'PP','EN':'EN','SH':'SH'}[g.type] || '';
      const photo = g.scorer_photo || '';
      return `
        <div class="goal-row">
          ${photo ? `<img class="goal-photo" src="${photo}" onerror="this.style.display='none'"/>` : '<div class="goal-photo-empty"></div>'}
          <span class="goal-time">${g.time || ''}</span>
          <span class="goal-period">${g.period || ''}.</span>
          <span class="goal-scorer">${scorer}${g.scorer_jersey ? ` <span class="goal-jersey">#${g.scorer_jersey}</span>` : ''}${typeLabel ? ` <span class="goal-type">${typeLabel}</span>` : ''}</span>
          <span class="goal-assists">${assists || ''}</span>
        </div>`;
    }).join('');
    return `<div class="detail-section"><div class="detail-title">TORE</div><div class="goal-list">${rows}</div></div>`;
  }

  _renderNextGame(a, state) {
    const iso = a.match_start_iso || null;
    const cd = this._calcCountdown(iso);
    const opponent = a.opponent || a.away_team || '?';
    const loc = a.is_home ? 'Heim' : 'Auswärts';
    return `
      <div class="info-card next-card">
        <div class="info-label">NÄCHSTES SPIEL</div>
        <div class="info-opponent">${opponent}</div>
        <div class="info-meta">${state || ''} · ${loc}</div>
        ${cd ? `<div class="cd-time" data-iso="${iso || ''}">${cd}</div>` : ''}
      </div>`;
  }

  _renderLastGame(a) {
    const opponent = a.opponent || a.away_team || '?';
    const loc = a.is_home ? 'Heim' : 'Auswärts';
    return `
      <div class="info-card last-card">
        <div class="info-label">LETZTES SPIEL</div>
        <div class="info-opponent">${opponent}</div>
        <div class="last-score">${a.score_home ?? 0} : ${a.score_away ?? 0}</div>
        <div class="info-meta">${a.match_start || ''} · ${loc}</div>
      </div>`;
  }
}

/* ═══════════════════════════════════════════════
   CSS
   ═══════════════════════════════════════════════ */
const STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :host {
    --home: #0066CC; --home-dim: #002244;
    --away: #CC0000; --away-dim: #330000;
    --bg: #000; --txt: #fff; --txt-dim: rgba(255,255,255,0.28); --txt-mid: rgba(255,255,255,0.55);
    --ring-red: #BB0000; --ring-dark: #660000;
    --detail-bg: #0e0e12; --card-bg: #141418;
  }
  ha-card { background: transparent !important; border: none !important; box-shadow: none !important; }
  .cube { font-family: 'Segoe UI','Arial Black',system-ui,sans-serif; -webkit-font-smoothing: antialiased; position: relative; }

  /* ─── SCOREBOARD ─── */
  .screen { background: #111; border-radius: 8px 8px 0 0; overflow: hidden; border: 4px solid #1a1a1a; border-bottom: none;
    box-shadow: 0 2px 16px rgba(0,0,0,0.9), inset 0 0 40px rgba(0,0,0,0.8); }
  .screen:only-child { border-radius: 8px; border-bottom: 4px solid #1a1a1a; }
  .panel { background: var(--bg); padding: 12px 10px 8px; min-height: 170px; display: flex; flex-direction: column; gap: 6px; }

  .row-top { display: flex; align-items: flex-start; }
  .straf-col { flex: 0 0 60px; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .straf-title { font-size: 7px; font-weight: 800; letter-spacing: 1.5px; color: var(--txt-dim); }
  .straf-box { width: 46px; height: 18px; border-radius: 2px; background: #0a0a0a; border: 1px solid #1a1a1a; }
  .clock-col { flex: 1; display: flex; flex-direction: column; align-items: center; }
  .team-row { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; }
  .team-name { font-size: 14px; font-weight: 900; letter-spacing: 3px; min-width: 46px; }
  .home-c { color: var(--home); text-align: right; }
  .away-c { color: var(--away); text-align: left; }
  .clock { font-size: 26px; font-weight: 900; color: var(--txt); letter-spacing: 2px; text-shadow: 0 0 14px rgba(255,255,255,0.3); font-variant-numeric: tabular-nums; min-width: 80px; text-align: center; }
  .live .clock { text-shadow: 0 0 18px rgba(255,255,255,0.45); }

  .row-score { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
  .pblocks-col { flex: 0 0 42px; display: flex; flex-direction: column; gap: 4px; align-items: center; }
  .led-block { width: 38px; height: 26px; border-radius: 3px; display: flex; align-items: center; justify-content: center; }
  .led-block.home.on { background: var(--home); box-shadow: 0 0 8px rgba(0,102,204,0.5), inset 0 1px 0 rgba(255,255,255,0.15); }
  .led-block.home.off { background: var(--home-dim); border: 1px solid rgba(0,102,204,0.2); }
  .led-block.away.on { background: var(--away); box-shadow: 0 0 8px rgba(204,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15); }
  .led-block.away.off { background: var(--away-dim); border: 1px solid rgba(204,0,0,0.2); }
  .led-val { font-size: 16px; font-weight: 900; color: var(--txt); text-shadow: 0 0 4px rgba(255,255,255,0.3); }
  .led-block.off .led-val { color: rgba(255,255,255,0.1); }

  .score-col { flex: 1; display: flex; align-items: center; justify-content: center; }
  .score-display { display: flex; align-items: center; justify-content: center; gap: 6px; }
  .score-digit { font-size: 72px; font-weight: 900; color: var(--txt); line-height: 1; min-width: 50px; text-align: center;
    text-shadow: 0 0 18px rgba(255,255,255,0.25), 0 0 40px rgba(255,255,255,0.08); }
  .live .score-digit { text-shadow: 0 0 22px rgba(255,255,255,0.35), 0 0 50px rgba(255,255,255,0.12); }
  .period-circle { width: 30px; height: 30px; border-radius: 50%; background: #333; border: 2px solid #555;
    display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 900; color: var(--txt); flex-shrink: 0; }
  .period-circle.active { background: var(--away); border-color: #ff4444; box-shadow: 0 0 12px rgba(204,0,0,0.6); }
  .future-vs { font-size: 40px; font-weight: 900; color: var(--txt-dim); letter-spacing: 6px; text-align: center; }

  .ticker { text-align: center; padding: 5px 8px; font-size: 11px; font-weight: 600; color: var(--txt);
    background: linear-gradient(90deg,transparent,rgba(0,102,204,0.12),transparent); border-radius: 3px; }
  .ticker strong { font-weight: 800; }
  .ticker-time { color: rgba(255,255,255,0.4); margin-left: 6px; }

  .led-ring { display: flex; align-items: center; justify-content: center; padding: 9px 16px;
    background: linear-gradient(180deg, var(--ring-dark) 0%, var(--ring-red) 30%, var(--ring-red) 70%, var(--ring-dark) 100%); border-top: 1px solid #ee2222; }
  .led-ring.glow { animation: ring-pulse 2.5s ease-in-out infinite; }
  @keyframes ring-pulse { 0%,100%{filter:brightness(0.85)} 50%{filter:brightness(1.1)} }
  .led-text { font-size: 14px; font-weight: 900; letter-spacing: 5px; color: var(--txt); text-shadow: 0 0 10px rgba(255,255,255,0.5); }

  .standby .panel { min-height: 150px; justify-content: center; }
  .standby-text { text-align: center; font-size: 12px; font-weight: 800; letter-spacing: 4px; color: var(--txt-dim); }

  /* ═══ GOAL ALERT OVERLAY ═══ */
  .goal-overlay {
    position: absolute;
    inset: 0;
    z-index: 100;
    border-radius: 8px;
    overflow: hidden;
    background: rgba(0,0,0,0.92);
    animation: overlay-in 0.3s ease-out;
  }
  @keyframes overlay-in { from { opacity: 0; transform: scale(1.05); } to { opacity: 1; transform: scale(1); } }

  /* Phase 1: TOOOR! */
  .alert-phase1 {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; gap: 8px; animation: phase1-pulse 0.6s ease-in-out infinite alternate;
  }
  .goal-overlay.phase2 .alert-phase1 { display: none; }

  @keyframes phase1-pulse {
    from { background: radial-gradient(circle, rgba(0,102,204,0.3) 0%, rgba(0,0,0,0) 70%); }
    to   { background: radial-gradient(circle, rgba(204,0,0,0.3) 0%, rgba(0,0,0,0) 70%); }
  }

  .alert-siren { font-size: 48px; animation: siren-spin 0.5s ease-in-out infinite alternate; }
  @keyframes siren-spin { from { transform: rotate(-10deg) scale(1); } to { transform: rotate(10deg) scale(1.1); } }

  .alert-tor {
    font-size: 56px; font-weight: 900; color: var(--txt); letter-spacing: 8px;
    text-shadow: 0 0 30px var(--home), 0 0 60px rgba(0,102,204,0.5), 0 4px 8px rgba(0,0,0,0.8);
    animation: tor-glow 0.8s ease-in-out infinite alternate;
  }
  @keyframes tor-glow {
    from { text-shadow: 0 0 30px var(--home), 0 0 60px rgba(0,102,204,0.5); }
    to   { text-shadow: 0 0 40px var(--away), 0 0 80px rgba(204,0,0,0.5); }
  }

  .alert-score { font-size: 24px; font-weight: 800; color: var(--txt-mid); letter-spacing: 4px; }

  /* Phase 2: Scorer */
  .alert-phase2 {
    display: none; flex-direction: row; align-items: center; justify-content: center;
    height: 100%; gap: 16px; padding: 16px;
  }
  .goal-overlay.phase2 .alert-phase2 { display: flex; animation: phase2-in 0.5s ease-out; }
  @keyframes phase2-in { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

  .alert-photo {
    width: 120px; height: 120px; object-fit: contain; border-radius: 8px;
    background: radial-gradient(circle, rgba(0,102,204,0.15) 0%, transparent 70%);
    filter: drop-shadow(0 0 16px rgba(0,102,204,0.4));
  }

  .alert-info { display: flex; flex-direction: column; gap: 4px; }
  .alert-label { font-size: 9px; font-weight: 800; letter-spacing: 3px; color: var(--home); text-transform: uppercase; }
  .alert-name { font-size: 26px; font-weight: 900; color: var(--txt); line-height: 1.1;
    text-shadow: 0 0 12px rgba(0,102,204,0.3); }
  .alert-jersey { font-size: 18px; font-weight: 800; color: var(--txt-mid); }
  .alert-assists { font-size: 12px; color: var(--txt-mid); font-style: italic; }
  .alert-time { font-size: 11px; color: var(--txt-dim); margin-top: 2px; }
  .alert-score2 { font-size: 20px; font-weight: 900; color: var(--txt); letter-spacing: 3px; margin-top: 4px; }

  /* ─── DETAILS PANEL ─── */
  .details { background: var(--detail-bg); border: 4px solid #1a1a1a; border-top: 1px solid #222;
    border-radius: 0 0 8px 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .detail-section { }
  .detail-title { font-size: 9px; font-weight: 800; letter-spacing: 2.5px; color: var(--txt-dim);
    margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid #1a1a1a; }

  .goal-list { display: flex; flex-direction: column; gap: 3px; }
  .goal-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px;
    font-size: 11px; color: var(--txt-mid); background: rgba(255,255,255,0.02); }
  .goal-row:hover { background: rgba(255,255,255,0.04); }

  .goal-photo { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; background: #1a1a1a; flex-shrink: 0; }
  .goal-photo-empty { width: 28px; height: 28px; border-radius: 50%; background: #1a1a1a; flex-shrink: 0; }
  .goal-time { font-weight: 700; color: var(--txt); min-width: 36px; font-variant-numeric: tabular-nums; }
  .goal-period { font-weight: 600; color: var(--txt-dim); min-width: 16px; font-size: 10px; }
  .goal-scorer { font-weight: 700; color: var(--txt); flex: 1; }
  .goal-jersey { font-size: 9px; font-weight: 700; color: var(--txt-dim); }
  .goal-type { font-size: 9px; font-weight: 800; color: var(--home); background: rgba(0,102,204,0.15); padding: 1px 4px; border-radius: 3px; margin-left: 4px; }
  .goal-assists { font-size: 10px; color: var(--txt-dim); font-style: italic; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .info-row { display: flex; gap: 8px; }
  .info-card { flex: 1; background: var(--card-bg); border-radius: 6px; padding: 10px; border: 1px solid #1e1e24; }
  .info-label { font-size: 8px; font-weight: 800; letter-spacing: 2px; color: var(--txt-dim); margin-bottom: 4px; }
  .info-opponent { font-size: 13px; font-weight: 800; color: var(--txt); margin-bottom: 2px; }
  .info-meta { font-size: 10px; color: var(--txt-dim); }
  .cd-time { font-size: 18px; font-weight: 900; color: var(--home); margin-top: 4px; letter-spacing: 1px; font-variant-numeric: tabular-nums; }
  .last-score { font-size: 20px; font-weight: 900; color: var(--txt); margin: 2px 0; letter-spacing: 2px; }
`;

customElements.define('adler-mannheim-scoreboard', AdlerMannheimScoreboard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'adler-mannheim-scoreboard', name: 'Adler Mannheim Scoreboard', description: 'SAP Arena Videowürfel + Goal Alerts', preview: true });
console.info(`%c ADLER-SCOREBOARD %c v${CARD_VERSION} `, 'background:#CC0000;color:#fff;font-weight:bold;padding:2px 8px;border-radius:4px 0 0 4px', 'background:#222;color:#fff;padding:2px 8px;border-radius:0 4px 4px 0');
