const CARD_VERSION = '4.0.0';

class AdlerMannheimScoreboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._countdownTimer = null;
  }

  setConfig(config) {
    this._config = {
      entity: 'sensor.adler_mannheim_aktuelles_spiel',
      entity_next: 'sensor.adler_mannheim_nachstes_spiel',
      entity_last: 'sensor.adler_mannheim_letztes_spiel',
      ...config,
    };
  }

  connectedCallback() {
    this._startCountdown();
  }

  disconnectedCallback() {
    this._stopCountdown();
  }

  _startCountdown() {
    this._stopCountdown();
    this._countdownTimer = setInterval(() => {
      const el = this.shadowRoot && this.shadowRoot.querySelector('.cd-time');
      if (el) {
        const iso = el.dataset.iso;
        if (iso) el.textContent = this._calcCountdown(iso);
      }
    }, 30000); // update every 30s
  }

  _stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    const ids = [this._config.entity, this._config.entity_next, this._config.entity_last];
    const changed = !prev || ids.some(id => {
      const o = prev.states[id];
      const n = hass.states[id];
      if (!o && !n) return false;
      if (!o || !n) return true;
      return o.state !== n.state || JSON.stringify(o.attributes) !== JSON.stringify(n.attributes);
    });
    if (changed) this._render();
  }

  getCardSize() { return 7; }
  static getStubConfig() { return { entity: 'sensor.adler_mannheim_aktuelles_spiel' }; }

  /* ── Entity helpers ── */
  _getEntity(id) {
    const s = this._hass.states[id];
    if (!s || !s.state || ['None', 'unavailable', 'unknown'].includes(s.state)) return null;
    return s;
  }

  _getMainGame() {
    const cur = this._getEntity(this._config.entity);
    if (cur) {
      const st = (cur.attributes.status || '').toUpperCase();
      return { state: cur, mode: st === 'LIVE' ? 'live' : st === 'FUTURE' ? 'next' : 'result' };
    }
    const nxt = this._getEntity(this._config.entity_next);
    if (nxt) return { state: nxt, mode: 'next' };
    const lst = this._getEntity(this._config.entity_last);
    if (lst) return { state: lst, mode: 'result' };
    return null;
  }

  /* ── Countdown ── */
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
        </div>
      </ha-card>`;
  }

  _renderStandby() {
    return `
      <div class="screen standby">
        <div class="panel"><div class="standby-text">KEINE SPIELDATEN</div></div>
        <div class="led-ring"><span class="led-text">ADLER MANNHEIM.DE</span></div>
      </div>`;
  }

  /* ══════════════════════════════════════════
     SCOREBOARD (top section — Videowürfel)
     ══════════════════════════════════════════ */
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
    if (a.overtime) {
      const [h, aw] = a.overtime.split(':').map(Number);
      pScores.push([h, aw]); hasOT = true;
    }

    return `
      <div class="screen ${mode}">
        <div class="panel">
          <div class="row-top">
            <div class="straf-col"><div class="straf-title">STRAFZEIT</div><div class="straf-box"></div></div>
            <div class="clock-col">
              <div class="team-row">
                <span class="team-name home-c">${homeShort}</span>
                <span class="clock">${isLive ? '20:00' : isNext ? (state.state || '') : 'ENDE'}</span>
                <span class="team-name away-c">${awayShort}</span>
              </div>
            </div>
            <div class="straf-col"><div class="straf-title">STRAFZEIT</div><div class="straf-box"></div></div>
          </div>
          <div class="row-score">
            <div class="pblocks-col">${this._renderBlocks(pScores, 0)}</div>
            <div class="score-col">
              ${isNext
                ? '<div class="future-vs">VS</div>'
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
      const p = pScores[i];
      const val = p ? p[teamIdx] : null;
      const on = p !== null;
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

  /* ══════════════════════════════════════════
     DETAILS PANEL (below scoreboard)
     ══════════════════════════════════════════ */
  _renderDetails(main) {
    const nextEntity = this._getEntity(this._config.entity_next);
    const lastEntity = this._getEntity(this._config.entity_last);

    // Get goals from the main displayed game (live or last result)
    let goalsHtml = '';
    const gameWithGoals = main ? main.state : null;
    if (gameWithGoals && gameWithGoals.attributes.goals && gameWithGoals.attributes.goals.length > 0) {
      goalsHtml = this._renderGoalList(gameWithGoals.attributes);
    }

    // Next game
    let nextHtml = '';
    if (nextEntity) {
      nextHtml = this._renderNextGame(nextEntity.attributes, nextEntity.state);
    }

    // Last game (only if not already shown as main)
    let lastHtml = '';
    if (lastEntity && main && main.mode !== 'result') {
      lastHtml = this._renderLastGame(lastEntity.attributes);
    }

    if (!goalsHtml && !nextHtml && !lastHtml) return '';

    return `
      <div class="details">
        ${goalsHtml}
        <div class="info-row">
          ${nextHtml}
          ${lastHtml}
        </div>
      </div>`;
  }

  _renderGoalList(a) {
    const goals = a.goals || [];
    if (!goals.length) return '';

    const rows = goals.map(g => {
      const scorer = g.scorer || '?';
      const assists = [g.assist1, g.assist2].filter(Boolean).join(', ');
      const typeLabel = g.type === 'PP' ? 'PP' : g.type === 'EN' ? 'EN' : g.type === 'SH' ? 'SH' : '';
      return `
        <div class="goal-row">
          <span class="goal-time">${g.time || ''}</span>
          <span class="goal-period">${g.period || ''}.</span>
          <span class="goal-scorer">${scorer}${typeLabel ? ` <span class="goal-type">${typeLabel}</span>` : ''}</span>
          <span class="goal-assists">${assists || ''}</span>
        </div>`;
    }).join('');

    return `
      <div class="detail-section">
        <div class="detail-title">TORE</div>
        <div class="goal-list">${rows}</div>
      </div>`;
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
    const scoreHome = a.score_home ?? 0;
    const scoreAway = a.score_away ?? 0;

    return `
      <div class="info-card last-card">
        <div class="info-label">LETZTES SPIEL</div>
        <div class="info-opponent">${opponent}</div>
        <div class="last-score">${scoreHome} : ${scoreAway}</div>
        <div class="info-meta">${a.match_start || ''} · ${loc}</div>
      </div>`;
  }
}

/* ═══════════════════════════════════════════════════
   CSS
   ═══════════════════════════════════════════════════ */
const STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  :host {
    --home:       #0066CC;
    --home-dim:   #002244;
    --away:       #CC0000;
    --away-dim:   #330000;
    --bg:         #000000;
    --txt:        #ffffff;
    --txt-dim:    rgba(255,255,255,0.28);
    --txt-mid:    rgba(255,255,255,0.55);
    --ring-red:   #BB0000;
    --ring-dark:  #660000;
    --detail-bg:  #0e0e12;
    --card-bg:    #141418;
  }

  ha-card { background: transparent !important; border: none !important; box-shadow: none !important; }
  .cube { font-family: 'Segoe UI', 'Arial Black', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }

  /* ─── SCOREBOARD ─── */
  .screen { background: #111; border-radius: 8px 8px 0 0; overflow: hidden; border: 4px solid #1a1a1a; border-bottom: none;
    box-shadow: 0 2px 16px rgba(0,0,0,0.9), inset 0 0 40px rgba(0,0,0,0.8); }
  .screen:only-child { border-radius: 8px; border-bottom: 4px solid #1a1a1a; }

  .panel { background: var(--bg); padding: 12px 10px 8px; min-height: 170px; display: flex; flex-direction: column; gap: 6px; }

  .row-top { display: flex; align-items: flex-start; }
  .straf-col { flex: 0 0 60px; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .straf-title { font-size: 7px; font-weight: 800; letter-spacing: 1.5px; color: var(--txt-dim); text-transform: uppercase; }
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
    display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 900; color: var(--txt); flex-shrink: 0; margin: 0 2px; }
  .period-circle.active { background: var(--away); border-color: #ff4444; box-shadow: 0 0 12px rgba(204,0,0,0.6); }

  .future-vs { font-size: 40px; font-weight: 900; color: var(--txt-dim); letter-spacing: 6px; text-align: center; }

  .ticker { text-align: center; padding: 5px 8px; font-size: 11px; font-weight: 600; color: var(--txt);
    background: linear-gradient(90deg, transparent, rgba(0,102,204,0.12), transparent); border-radius: 3px; animation: ticker-pop 2s ease-out; }
  @keyframes ticker-pop { 0%{background:linear-gradient(90deg,transparent,rgba(0,102,204,0.5),transparent)} 100%{background:linear-gradient(90deg,transparent,rgba(0,102,204,0.12),transparent)} }
  .ticker strong { font-weight: 800; }
  .ticker-time { color: rgba(255,255,255,0.4); margin-left: 6px; }

  .led-ring { display: flex; align-items: center; justify-content: center; padding: 9px 16px;
    background: linear-gradient(180deg, var(--ring-dark) 0%, var(--ring-red) 30%, var(--ring-red) 70%, var(--ring-dark) 100%);
    border-top: 1px solid #ee2222; }
  .led-ring.glow { animation: ring-pulse 2.5s ease-in-out infinite; }
  @keyframes ring-pulse { 0%,100%{filter:brightness(0.85)} 50%{filter:brightness(1.1)} }
  .led-text { font-size: 14px; font-weight: 900; letter-spacing: 5px; color: var(--txt); text-transform: uppercase; text-shadow: 0 0 10px rgba(255,255,255,0.5); }

  .standby .panel { min-height: 150px; justify-content: center; }
  .standby-text { text-align: center; font-size: 12px; font-weight: 800; letter-spacing: 4px; color: var(--txt-dim); }

  /* ─── DETAILS PANEL ─── */
  .details {
    background: var(--detail-bg);
    border: 4px solid #1a1a1a;
    border-top: 1px solid #222;
    border-radius: 0 0 8px 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .detail-section { }
  .detail-title {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 2.5px;
    color: var(--txt-dim);
    text-transform: uppercase;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid #1a1a1a;
  }

  /* Goal list */
  .goal-list { display: flex; flex-direction: column; gap: 3px; }
  .goal-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--txt-mid);
    background: rgba(255,255,255,0.02);
  }
  .goal-row:hover { background: rgba(255,255,255,0.04); }
  .goal-time { font-weight: 700; color: var(--txt); min-width: 36px; font-variant-numeric: tabular-nums; }
  .goal-period { font-weight: 600; color: var(--txt-dim); min-width: 16px; font-size: 10px; }
  .goal-scorer { font-weight: 700; color: var(--txt); flex: 1; }
  .goal-type { font-size: 9px; font-weight: 800; color: var(--home); background: rgba(0,102,204,0.15); padding: 1px 4px; border-radius: 3px; margin-left: 4px; }
  .goal-assists { font-size: 10px; color: var(--txt-dim); font-style: italic; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Info cards row (next + last game) */
  .info-row { display: flex; gap: 8px; }
  .info-card {
    flex: 1;
    background: var(--card-bg);
    border-radius: 6px;
    padding: 10px;
    border: 1px solid #1e1e24;
  }
  .info-label {
    font-size: 8px;
    font-weight: 800;
    letter-spacing: 2px;
    color: var(--txt-dim);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .info-opponent {
    font-size: 13px;
    font-weight: 800;
    color: var(--txt);
    margin-bottom: 2px;
  }
  .info-meta {
    font-size: 10px;
    color: var(--txt-dim);
  }

  /* Countdown */
  .cd-time {
    font-size: 18px;
    font-weight: 900;
    color: var(--home);
    margin-top: 4px;
    letter-spacing: 1px;
    font-variant-numeric: tabular-nums;
  }

  /* Last game score */
  .last-score {
    font-size: 20px;
    font-weight: 900;
    color: var(--txt);
    margin: 2px 0;
    letter-spacing: 2px;
  }
`;

customElements.define('adler-mannheim-scoreboard', AdlerMannheimScoreboard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'adler-mannheim-scoreboard',
  name: 'Adler Mannheim Scoreboard',
  description: 'SAP Arena Videowürfel + Details',
  preview: true,
});

console.info(
  `%c ADLER-SCOREBOARD %c v${CARD_VERSION} `,
  'background:#CC0000;color:#fff;font-weight:bold;padding:2px 8px;border-radius:4px 0 0 4px',
  'background:#222;color:#fff;padding:2px 8px;border-radius:0 4px 4px 0'
);
