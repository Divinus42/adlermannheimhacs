const CARD_VERSION = '6.0.0';

class AdlerMannheimScoreboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._countdownTimer = null;
    this._lastGoalCount = -1;
    this._goalAlertTimeout = null;
    this._showingAlert = false;
    this._alertGoal = null;
    this._expandedPanel = null;  // 'last' or 'next'
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

  _togglePanel(panel) {
    this._expandedPanel = this._expandedPanel === panel ? null : panel;
    this._render();
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
          ${this._renderDetails()}
          ${this._showingAlert ? this._renderGoalOverlay() : ''}
        </div>
      </ha-card>`;

    // Attach click listeners for expandable panels
    const sr = this.shadowRoot;
    const nextCard = sr.querySelector('.next-card');
    if (nextCard) nextCard.addEventListener('click', () => this._togglePanel('next'));
    const lastCard = sr.querySelector('.last-card');
    if (lastCard) lastCard.addEventListener('click', () => this._togglePanel('last'));
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
  _renderDetails() {
    const e = this._discoverEntities();
    const nextEntity = e.future;
    const lastEntity = e.final;

    let nextHtml = '';
    if (nextEntity) nextHtml = this._renderNextGame(nextEntity.attributes, nextEntity.state);

    let lastHtml = '';
    if (lastEntity) lastHtml = this._renderLastGame(lastEntity.attributes);

    if (!nextHtml && !lastHtml) return '';

    return `
      <div class="details">
        <div class="info-row">${nextHtml}${lastHtml}</div>
        ${this._expandedPanel === 'next' && nextEntity ? this._renderNextExpanded(nextEntity.attributes) : ''}
        ${this._expandedPanel === 'last' && lastEntity ? this._renderTimeline(lastEntity.attributes) : ''}
      </div>`;
  }

  _renderNextGame(a, state) {
    const iso = a.match_start_iso || null;
    const cd = this._calcCountdown(iso);
    const opponent = a.opponent || a.away_team || '?';
    const loc = a.is_home ? 'Heim' : 'Auswärts';
    const exp = this._expandedPanel === 'next';
    return `
      <div class="info-card next-card clickable ${exp ? 'expanded' : ''}">
        <div class="info-label">NÄCHSTES SPIEL <span class="expand-icon">${exp ? '▲' : '▼'}</span></div>
        <div class="info-opponent">${opponent}</div>
        <div class="info-meta">${state || ''} · ${loc}</div>
        ${cd ? `<div class="cd-time" data-iso="${iso || ''}">${cd}</div>` : ''}
      </div>`;
  }

  _renderLastGame(a) {
    const opponent = a.opponent || a.away_team || '?';
    const loc = a.is_home ? 'Heim' : 'Auswärts';
    const exp = this._expandedPanel === 'last';
    return `
      <div class="info-card last-card clickable ${exp ? 'expanded' : ''}">
        <div class="info-label">LETZTES SPIEL <span class="expand-icon">${exp ? '▲' : '▼'}</span></div>
        <div class="info-opponent">${opponent}</div>
        <div class="last-score">${a.score_home ?? 0} : ${a.score_away ?? 0}</div>
        <div class="info-meta">${a.match_start || ''} · ${loc}</div>
      </div>`;
  }

  /* ── Next game expanded details ── */
  _renderNextExpanded(a) {
    const home = a.home_team || '?';
    const away = a.away_team || '?';
    const comp = a.competition || '';
    const iso = a.match_start_iso || null;
    const cd = this._calcCountdown(iso);

    return `
      <div class="expanded-panel">
        <div class="exp-matchup">
          <div class="exp-team">
            ${a.home_logo ? `<img class="exp-logo" src="${a.home_logo}" onerror="this.style.display='none'"/>` : ''}
            <span class="exp-tname">${home}</span>
            ${a.is_home === true ? '' : a.is_home === false ? '' : ''}
          </div>
          <div class="exp-vs">VS</div>
          <div class="exp-team">
            ${a.away_logo ? `<img class="exp-logo" src="${a.away_logo}" onerror="this.style.display='none'"/>` : ''}
            <span class="exp-tname">${away}</span>
          </div>
        </div>
        <div class="exp-info-grid">
          <div class="exp-info-item"><span class="exp-key">Anpfiff</span><span class="exp-val">${a.match_start || '?'}</span></div>
          <div class="exp-info-item"><span class="exp-key">Countdown</span><span class="exp-val exp-cd">${cd || '?'}</span></div>
          <div class="exp-info-item"><span class="exp-key">Wettbewerb</span><span class="exp-val">${comp}</span></div>
          <div class="exp-info-item"><span class="exp-key">Ort</span><span class="exp-val">${a.is_home ? 'Heim (SAP Arena)' : 'Auswärts'}</span></div>
        </div>
      </div>`;
  }

  /* ── Last game timeline ── */
  _renderTimeline(a) {
    // Merge goals + penalties into one timeline, sorted by period then time
    const events = [];

    for (const g of (a.goals || [])) {
      events.push({
        period: g.period || 0,
        time: g.time || '00:00',
        type: g.is_adler_goal ? 'adler-goal' : 'opp-goal',
        primary: g.scorer || '?',
        jersey: g.scorer_jersey,
        photo: g.scorer_photo,
        secondary: [g.assist1, g.assist2].filter(Boolean).join(', '),
        badge: g.type && g.type !== 'ES' ? g.type : null,
      });
    }

    for (const p of (a.penalties || [])) {
      events.push({
        period: p.period || 0,
        time: p.time || '00:00',
        type: 'penalty',
        primary: p.player || '?',
        secondary: p.infraction || '',
        badge: p.minutes || '2 Min',
      });
    }

    // Sort by period, then by time
    events.sort((a, b) => {
      if (a.period !== b.period) return a.period - b.period;
      return a.time.localeCompare(b.time);
    });

    if (!events.length) return '<div class="expanded-panel"><div class="tl-empty">Keine Ereignisse</div></div>';

    // Group by period
    let html = '';
    let lastPeriod = 0;
    for (const ev of events) {
      if (ev.period !== lastPeriod) {
        lastPeriod = ev.period;
        html += `<div class="tl-period-header">${ev.period}. DRITTEL</div>`;
      }

      const dotClass = ev.type === 'adler-goal' ? 'dot-adler'
        : ev.type === 'opp-goal' ? 'dot-opp' : 'dot-penalty';

      html += `
        <div class="tl-event ${ev.type}">
          <div class="tl-time">${ev.time}</div>
          <div class="tl-line"><div class="tl-dot ${dotClass}"></div></div>
          <div class="tl-content">
            <div class="tl-primary">
              ${ev.photo ? `<img class="tl-photo" src="${ev.photo}" onerror="this.style.display='none'"/>` : ''}
              <span>${ev.primary}${ev.jersey ? ` <span class="tl-jersey">#${ev.jersey}</span>` : ''}</span>
              ${ev.badge ? `<span class="tl-badge ${ev.type}">${ev.badge}</span>` : ''}
            </div>
            ${ev.secondary ? `<div class="tl-secondary">${ev.type === 'penalty' ? ev.secondary : 'Assists: ' + ev.secondary}</div>` : ''}
          </div>
        </div>`;
    }

    // Summary
    const adlerGoals = (a.goals || []).filter(g => g.is_adler_goal).length;
    const oppGoals = (a.goals || []).filter(g => !g.is_adler_goal).length;
    const totalPen = (a.penalties || []).length;

    return `
      <div class="expanded-panel">
        <div class="tl-summary">
          <span class="tl-sum-item"><span class="dot-adler-sm"></span> ${adlerGoals} Adler-Tore</span>
          <span class="tl-sum-item"><span class="dot-opp-sm"></span> ${oppGoals} Gegentore</span>
          <span class="tl-sum-item"><span class="dot-pen-sm"></span> ${totalPen} Strafen</span>
        </div>
        <div class="timeline">${html}</div>
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
  ha-card { background: transparent !important; border: none !important; box-shadow: none !important; overflow: hidden; }
  .cube { font-family: 'Segoe UI','Arial Black',system-ui,sans-serif; -webkit-font-smoothing: antialiased; position: relative; width: 100%; overflow: hidden; }

  /* ─── SCOREBOARD ─── */
  .screen { background: #111; border-radius: 8px 8px 0 0; overflow: hidden; border: 3px solid #1a1a1a; border-bottom: none;
    box-shadow: 0 2px 16px rgba(0,0,0,0.9), inset 0 0 40px rgba(0,0,0,0.8); }
  .screen:only-child { border-radius: 8px; border-bottom: 3px solid #1a1a1a; }
  .panel { background: var(--bg); padding: 10px 6px 6px; min-height: 140px; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }

  .row-top { display: flex; align-items: flex-start; }
  .straf-col { flex: 0 0 48px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .straf-title { font-size: 6px; font-weight: 800; letter-spacing: 1px; color: var(--txt-dim); }
  .straf-box { width: 36px; height: 14px; border-radius: 2px; background: #0a0a0a; border: 1px solid #1a1a1a; }
  .clock-col { flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .team-row { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; }
  .team-name { font-size: 12px; font-weight: 900; letter-spacing: 2px; }
  .home-c { color: var(--home); text-align: right; }
  .away-c { color: var(--away); text-align: left; }
  .clock { font-size: 20px; font-weight: 900; color: var(--txt); letter-spacing: 1px; text-shadow: 0 0 14px rgba(255,255,255,0.3); font-variant-numeric: tabular-nums; text-align: center; white-space: nowrap; }
  .live .clock { text-shadow: 0 0 18px rgba(255,255,255,0.45); }

  .row-score { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
  .pblocks-col { flex: 0 0 32px; display: flex; flex-direction: column; gap: 3px; align-items: center; }
  .led-block { width: 30px; height: 22px; border-radius: 3px; display: flex; align-items: center; justify-content: center; }
  .led-block.home.on { background: var(--home); box-shadow: 0 0 6px rgba(0,102,204,0.5), inset 0 1px 0 rgba(255,255,255,0.15); }
  .led-block.home.off { background: var(--home-dim); border: 1px solid rgba(0,102,204,0.2); }
  .led-block.away.on { background: var(--away); box-shadow: 0 0 6px rgba(204,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15); }
  .led-block.away.off { background: var(--away-dim); border: 1px solid rgba(204,0,0,0.2); }
  .led-val { font-size: 13px; font-weight: 900; color: var(--txt); text-shadow: 0 0 4px rgba(255,255,255,0.3); }
  .led-block.off .led-val { color: rgba(255,255,255,0.1); }

  .score-col { flex: 1; display: flex; align-items: center; justify-content: center; min-width: 0; }
  .score-display { display: flex; align-items: center; justify-content: center; gap: 4px; }
  .score-digit { font-size: 52px; font-weight: 900; color: var(--txt); line-height: 1; min-width: 36px; text-align: center;
    text-shadow: 0 0 18px rgba(255,255,255,0.25), 0 0 40px rgba(255,255,255,0.08); }
  .live .score-digit { text-shadow: 0 0 22px rgba(255,255,255,0.35), 0 0 50px rgba(255,255,255,0.12); }
  .period-circle { width: 24px; height: 24px; border-radius: 50%; background: #333; border: 2px solid #555;
    display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 900; color: var(--txt); flex-shrink: 0; }
  .period-circle.active { background: var(--away); border-color: #ff4444; box-shadow: 0 0 10px rgba(204,0,0,0.6); }
  .future-vs { font-size: 32px; font-weight: 900; color: var(--txt-dim); letter-spacing: 4px; text-align: center; }

  .ticker { text-align: center; padding: 4px 6px; font-size: 10px; font-weight: 600; color: var(--txt);
    background: linear-gradient(90deg,transparent,rgba(0,102,204,0.12),transparent); border-radius: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ticker strong { font-weight: 800; }
  .ticker-time { color: rgba(255,255,255,0.4); margin-left: 4px; }

  .led-ring { display: flex; align-items: center; justify-content: center; padding: 7px 10px;
    background: linear-gradient(180deg, var(--ring-dark) 0%, var(--ring-red) 30%, var(--ring-red) 70%, var(--ring-dark) 100%); border-top: 1px solid #ee2222; }
  .led-ring.glow { animation: ring-pulse 2.5s ease-in-out infinite; }
  @keyframes ring-pulse { 0%,100%{filter:brightness(0.85)} 50%{filter:brightness(1.1)} }
  .led-text { font-size: 11px; font-weight: 900; letter-spacing: 3px; color: var(--txt); text-shadow: 0 0 10px rgba(255,255,255,0.5); }

  .standby .panel { min-height: 120px; justify-content: center; }
  .standby-text { text-align: center; font-size: 11px; font-weight: 800; letter-spacing: 3px; color: var(--txt-dim); }

  /* ═══ GOAL ALERT OVERLAY ═══ */
  .goal-overlay {
    position: absolute; inset: 0; z-index: 100; border-radius: 8px; overflow: hidden;
    background: rgba(0,0,0,0.92); animation: overlay-in 0.3s ease-out;
  }
  @keyframes overlay-in { from { opacity: 0; transform: scale(1.05); } to { opacity: 1; transform: scale(1); } }

  .alert-phase1 {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; gap: 6px; animation: phase1-pulse 0.6s ease-in-out infinite alternate;
  }
  .goal-overlay.phase2 .alert-phase1 { display: none; }
  @keyframes phase1-pulse {
    from { background: radial-gradient(circle, rgba(0,102,204,0.3) 0%, rgba(0,0,0,0) 70%); }
    to   { background: radial-gradient(circle, rgba(204,0,0,0.3) 0%, rgba(0,0,0,0) 70%); }
  }

  .alert-siren { font-size: 36px; animation: siren-spin 0.5s ease-in-out infinite alternate; }
  @keyframes siren-spin { from { transform: rotate(-10deg) scale(1); } to { transform: rotate(10deg) scale(1.1); } }

  .alert-tor {
    font-size: 40px; font-weight: 900; color: var(--txt); letter-spacing: 6px;
    text-shadow: 0 0 30px var(--home), 0 0 60px rgba(0,102,204,0.5), 0 4px 8px rgba(0,0,0,0.8);
    animation: tor-glow 0.8s ease-in-out infinite alternate;
  }
  @keyframes tor-glow {
    from { text-shadow: 0 0 30px var(--home), 0 0 60px rgba(0,102,204,0.5); }
    to   { text-shadow: 0 0 40px var(--away), 0 0 80px rgba(204,0,0,0.5); }
  }

  .alert-score { font-size: 20px; font-weight: 800; color: var(--txt-mid); letter-spacing: 3px; }

  .alert-phase2 {
    display: none; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; gap: 8px; padding: 12px; text-align: center;
  }
  .goal-overlay.phase2 .alert-phase2 { display: flex; animation: phase2-in 0.5s ease-out; }
  @keyframes phase2-in { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

  .alert-photo {
    width: 90px; height: 90px; object-fit: contain; border-radius: 8px;
    background: radial-gradient(circle, rgba(0,102,204,0.15) 0%, transparent 70%);
    filter: drop-shadow(0 0 12px rgba(0,102,204,0.4));
  }

  .alert-info { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .alert-label { font-size: 8px; font-weight: 800; letter-spacing: 2px; color: var(--home); text-transform: uppercase; }
  .alert-name { font-size: 20px; font-weight: 900; color: var(--txt); line-height: 1.1;
    text-shadow: 0 0 12px rgba(0,102,204,0.3); }
  .alert-jersey { font-size: 15px; font-weight: 800; color: var(--txt-mid); }
  .alert-assists { font-size: 11px; color: var(--txt-mid); font-style: italic; }
  .alert-time { font-size: 10px; color: var(--txt-dim); }
  .alert-score2 { font-size: 18px; font-weight: 900; color: var(--txt); letter-spacing: 2px; margin-top: 2px; }

  /* ─── DETAILS PANEL ─── */
  .details { background: var(--detail-bg); border: 3px solid #1a1a1a; border-top: 1px solid #222;
    border-radius: 0 0 8px 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
  .detail-title { font-size: 8px; font-weight: 800; letter-spacing: 2px; color: var(--txt-dim);
    margin-bottom: 4px; padding-bottom: 3px; border-bottom: 1px solid #1a1a1a; }

  .goal-list { display: flex; flex-direction: column; gap: 2px; }
  .goal-row { display: flex; align-items: center; gap: 5px; padding: 3px 4px; border-radius: 4px;
    font-size: 10px; color: var(--txt-mid); background: rgba(255,255,255,0.02); overflow: hidden; }

  .goal-photo { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; background: #1a1a1a; flex-shrink: 0; }
  .goal-photo-empty { width: 24px; height: 24px; border-radius: 50%; background: #1a1a1a; flex-shrink: 0; }
  .goal-time { font-weight: 700; color: var(--txt); min-width: 32px; font-variant-numeric: tabular-nums; font-size: 10px; }
  .goal-period { font-weight: 600; color: var(--txt-dim); min-width: 14px; font-size: 9px; }
  .goal-scorer { font-weight: 700; color: var(--txt); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .goal-jersey { font-size: 8px; font-weight: 700; color: var(--txt-dim); }
  .goal-type { font-size: 8px; font-weight: 800; color: var(--home); background: rgba(0,102,204,0.15); padding: 1px 3px; border-radius: 3px; margin-left: 2px; }
  .goal-assists { font-size: 9px; color: var(--txt-dim); font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; min-width: 0; }

  .info-row { display: flex; gap: 6px; }
  .info-card { flex: 1; background: var(--card-bg); border-radius: 6px; padding: 8px; border: 1px solid #1e1e24; min-width: 0; overflow: hidden; }
  .info-label { font-size: 7px; font-weight: 800; letter-spacing: 1.5px; color: var(--txt-dim); margin-bottom: 3px; }
  .info-opponent { font-size: 12px; font-weight: 800; color: var(--txt); margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .info-meta { font-size: 9px; color: var(--txt-dim); }
  .cd-time { font-size: 16px; font-weight: 900; color: var(--home); margin-top: 3px; letter-spacing: 1px; font-variant-numeric: tabular-nums; }
  .last-score { font-size: 18px; font-weight: 900; color: var(--txt); margin: 2px 0; letter-spacing: 2px; }

  /* ─── Clickable cards ─── */
  .clickable { cursor: pointer; transition: border-color 0.2s, background 0.2s; }
  .clickable:hover { border-color: #333; background: #1a1a20; }
  .clickable.expanded { border-color: var(--home); background: #12121a; }
  .expand-icon { float: right; font-size: 8px; color: var(--txt-dim); }

  /* ─── Expanded panel ─── */
  .expanded-panel { background: var(--card-bg); border: 1px solid #1e1e24; border-radius: 6px; padding: 10px; animation: expand-in 0.25s ease-out; }
  @keyframes expand-in { from { opacity: 0; max-height: 0; } to { opacity: 1; max-height: 800px; } }

  /* Next game expanded */
  .exp-matchup { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 10px; }
  .exp-team { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }
  .exp-logo { width: 48px; height: 48px; object-fit: contain; filter: drop-shadow(0 0 6px rgba(255,255,255,0.1)); }
  .exp-tname { font-size: 11px; font-weight: 700; color: var(--txt); text-align: center; }
  .exp-vs { font-size: 18px; font-weight: 900; color: var(--txt-dim); letter-spacing: 2px; }
  .exp-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .exp-info-item { background: rgba(255,255,255,0.02); border-radius: 4px; padding: 6px 8px; }
  .exp-key { display: block; font-size: 8px; font-weight: 700; color: var(--txt-dim); letter-spacing: 1px; text-transform: uppercase; }
  .exp-val { display: block; font-size: 13px; font-weight: 800; color: var(--txt); margin-top: 2px; }
  .exp-cd { color: var(--home); }

  /* ─── Timeline ─── */
  .tl-summary { display: flex; gap: 10px; justify-content: center; margin-bottom: 8px; flex-wrap: wrap; }
  .tl-sum-item { font-size: 9px; font-weight: 700; color: var(--txt-mid); display: flex; align-items: center; gap: 4px; }
  .dot-adler-sm, .dot-opp-sm, .dot-pen-sm { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot-adler-sm { background: var(--home); }
  .dot-opp-sm { background: var(--away); }
  .dot-pen-sm { background: #cc9900; }

  .tl-period-header {
    font-size: 8px; font-weight: 800; letter-spacing: 2px; color: var(--txt-dim);
    text-transform: uppercase; padding: 6px 0 3px 42px; border-top: 1px solid #1a1a1a;
  }
  .tl-period-header:first-child { border-top: none; }

  .timeline { display: flex; flex-direction: column; }

  .tl-event { display: flex; align-items: flex-start; gap: 0; min-height: 32px; }

  .tl-time {
    flex: 0 0 36px; font-size: 10px; font-weight: 700; color: var(--txt-mid);
    text-align: right; padding-top: 4px; font-variant-numeric: tabular-nums;
  }

  .tl-line {
    flex: 0 0 20px; display: flex; flex-direction: column; align-items: center; position: relative;
    padding-top: 5px;
  }
  .tl-line::before {
    content: ''; position: absolute; top: 0; bottom: 0; width: 1px; background: #222; left: 50%;
  }
  .tl-dot {
    width: 10px; height: 10px; border-radius: 50%; position: relative; z-index: 1; flex-shrink: 0;
  }
  .dot-adler { background: var(--home); box-shadow: 0 0 6px rgba(0,102,204,0.6); }
  .dot-opp { background: var(--away); box-shadow: 0 0 6px rgba(204,0,0,0.6); }
  .dot-penalty { background: #cc9900; box-shadow: 0 0 6px rgba(204,153,0,0.5); }

  .tl-content { flex: 1; padding: 2px 0 8px 6px; min-width: 0; }
  .tl-primary { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .tl-primary span { font-size: 11px; font-weight: 700; color: var(--txt); }
  .tl-photo { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
  .tl-jersey { font-size: 9px; font-weight: 600; color: var(--txt-dim); }
  .tl-badge {
    font-size: 8px; font-weight: 800; padding: 1px 4px; border-radius: 3px; flex-shrink: 0;
  }
  .tl-badge.adler-goal { color: var(--home); background: rgba(0,102,204,0.15); }
  .tl-badge.opp-goal { color: var(--away); background: rgba(204,0,0,0.15); }
  .tl-badge.penalty { color: #cc9900; background: rgba(204,153,0,0.12); }
  .tl-secondary { font-size: 9px; color: var(--txt-dim); font-style: italic; margin-top: 1px; }
  .tl-empty { text-align: center; padding: 16px; color: var(--txt-dim); font-size: 11px; }
`;

customElements.define('adler-mannheim-scoreboard', AdlerMannheimScoreboard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'adler-mannheim-scoreboard', name: 'Adler Mannheim Scoreboard', description: 'SAP Arena Videowürfel + Goal Alerts', preview: true });
console.info(`%c ADLER-SCOREBOARD %c v${CARD_VERSION} `, 'background:#CC0000;color:#fff;font-weight:bold;padding:2px 8px;border-radius:4px 0 0 4px', 'background:#222;color:#fff;padding:2px 8px;border-radius:0 4px 4px 0');
