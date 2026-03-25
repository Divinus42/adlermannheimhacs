const CARD_VERSION = '3.0.0';

class AdlerMannheimScoreboard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    this._config = {
      entity: 'sensor.adler_mannheim_aktuelles_spiel',
      entity_next: 'sensor.adler_mannheim_nachstes_spiel',
      entity_last: 'sensor.adler_mannheim_letztes_spiel',
      ...config,
    };
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

  getCardSize() { return 5; }
  static getStubConfig() { return { entity: 'sensor.adler_mannheim_aktuelles_spiel' }; }

  _getGameData() {
    const tryEntity = (id, forceMode) => {
      const s = this._hass.states[id];
      if (!s || !s.state || ['None', 'unavailable', 'unknown'].includes(s.state)) return null;
      const status = (s.attributes.status || '').toUpperCase();
      const mode = forceMode || (status === 'LIVE' ? 'live' : status === 'FUTURE' ? 'next' : 'result');
      return { state: s, mode };
    };
    return (
      tryEntity(this._config.entity) ||
      tryEntity(this._config.entity_next, 'next') ||
      tryEntity(this._config.entity_last, 'result')
    );
  }

  _render() {
    if (!this._hass) return;
    const data = this._getGameData();
    this.shadowRoot.innerHTML = `
      <ha-card>
        <style>${STYLES}</style>
        <div class="cube">
          ${data ? this._renderGame(data) : this._renderStandby()}
        </div>
      </ha-card>`;
  }

  _renderStandby() {
    return `
      <div class="screen standby">
        <div class="panel">
          <div class="standby-text">KEINE SPIELDATEN</div>
        </div>
        <div class="led-ring">
          <span class="led-text">ADLER MANNHEIM.DE</span>
        </div>
      </div>`;
  }

  _renderGame({ state, mode }) {
    const a = state.attributes;
    const isLive = mode === 'live';
    const isNext = mode === 'next';
    const homeScore = a.score_home ?? 0;
    const awayScore = a.score_away ?? 0;
    const homeShort = (a.home_team_short || (a.home_team || '???').substring(0, 3)).toUpperCase();
    const awayShort = (a.away_team_short || (a.away_team || '???').substring(0, 3)).toUpperCase();

    // Current period
    let currentPeriod = 1;
    if (a.period_3) currentPeriod = 3;
    else if (a.period_2) currentPeriod = 3;
    else if (a.period_1) currentPeriod = 2;
    if (a.overtime) currentPeriod = 4;
    if (isLive && a.goals && a.goals.length > 0) {
      const lp = a.goals[a.goals.length - 1].period;
      if (lp && lp > currentPeriod) currentPeriod = lp;
    }

    // Parse period scores into [home, away] per period
    const pScores = [];
    for (let i = 1; i <= 3; i++) {
      const p = a[`period_${i}`];
      if (p) {
        const [h, aw] = p.split(':').map(Number);
        pScores.push([h, aw]);
      } else {
        pScores.push(null);
      }
    }
    let hasOT = false;
    if (a.overtime) {
      const [h, aw] = a.overtime.split(':').map(Number);
      pScores.push([h, aw]);
      hasOT = true;
    }

    return `
      <div class="screen ${mode}">
        <div class="panel">

          <!-- Row 1: STRAFZEIT + Clock + STRAFZEIT -->
          <div class="row-top">
            <div class="straf-col">
              <div class="straf-title">STRAFZEIT</div>
              <div class="straf-box"></div>
            </div>
            <div class="clock-col">
              <div class="team-row">
                <span class="team-name home-c">${homeShort}</span>
                <span class="clock">${isLive ? '20:00' : isNext ? (state.state || '') : 'ENDE'}</span>
                <span class="team-name away-c">${awayShort}</span>
              </div>
            </div>
            <div class="straf-col">
              <div class="straf-title">STRAFZEIT</div>
              <div class="straf-box"></div>
            </div>
          </div>

          <!-- Row 2: Period blocks + Score + Period blocks -->
          <div class="row-score">

            <!-- Home period blocks (BLUE) -->
            <div class="pblocks-col">
              ${this._renderBlocks(pScores, 0)}
            </div>

            <!-- Center score -->
            <div class="score-col">
              ${isNext
                ? `<div class="future-display">
                     <div class="future-vs">VS</div>
                   </div>`
                : `<div class="score-display">
                     <span class="score-digit">${homeScore}</span>
                     <span class="period-circle ${isLive ? 'active' : ''}">${hasOT ? 'V' : currentPeriod}</span>
                     <span class="score-digit">${awayScore}</span>
                   </div>`
              }
            </div>

            <!-- Away period blocks (RED) -->
            <div class="pblocks-col">
              ${this._renderBlocks(pScores, 1)}
            </div>

          </div>

          <!-- Goal ticker -->
          ${isLive ? this._renderGoalTicker(a) : ''}

        </div>

        <!-- Red LED ring -->
        <div class="led-ring ${isLive ? 'glow' : ''}">
          <span class="led-text">ADLER MANNHEIM.DE</span>
        </div>
      </div>`;
  }

  /**
   * Render 3 (or 4) period block rows.
   * Each block shows one digit (home=index 0, away=index 1).
   * Home blocks are blue, away blocks are red.
   * @param {Array} pScores - [[homeScore, awayScore], ...] per period
   * @param {number} teamIdx - 0 for home, 1 for away
   */
  _renderBlocks(pScores, teamIdx) {
    const side = teamIdx === 0 ? 'home' : 'away';
    let html = '';
    const count = Math.max(pScores.length, 3);
    for (let i = 0; i < count && i < 4; i++) {
      const p = pScores[i];
      const val = p ? p[teamIdx] : null;
      const on = p !== null;
      html += `
        <div class="led-block ${side} ${on ? 'on' : 'off'}">
          <span class="led-val">${val !== null ? val : ''}</span>
        </div>`;
    }
    return html;
  }

  _renderGoalTicker(a) {
    const goals = a.goals;
    if (!goals || !goals.length) return '';
    const g = goals[goals.length - 1];
    if (!g.scorer) return '';
    const assists = [g.assist1, g.assist2].filter(Boolean).join(', ');
    return `
      <div class="ticker">
        <span class="ticker-siren">&#x1F6A8;</span>
        <strong>${g.scorer}</strong>${assists ? ` · ${assists}` : ''}
        <span class="ticker-time">${g.time || ''}</span>
      </div>`;
  }
}

/* ═══════════════════════════════════════════════════
   CSS — SAP Arena Videowürfel replica v3
   Matched to the actual cube photo
   ═══════════════════════════════════════════════════ */
const STYLES = `
  * { box-sizing: border-box; }

  :host {
    --home:       #0066CC;
    --home-dim:   #002244;
    --away:       #CC0000;
    --away-dim:   #330000;
    --bg:         #000000;
    --panel-bg:   #060608;
    --txt:        #ffffff;
    --txt-dim:    rgba(255,255,255,0.28);
    --ring-red:   #BB0000;
    --ring-dark:  #660000;
  }

  ha-card {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
  }

  .cube {
    font-family: 'Segoe UI', 'Arial Black', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* ─── Screen frame ─── */
  .screen {
    background: #111;
    border-radius: 8px;
    overflow: hidden;
    border: 4px solid #1a1a1a;
    box-shadow:
      0 2px 16px rgba(0,0,0,0.9),
      inset 0 0 40px rgba(0,0,0,0.8);
  }

  /* ─── Main LED panel ─── */
  .panel {
    background: var(--bg);
    padding: 12px 10px 8px;
    min-height: 170px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* ─── Row 1: Strafzeit + Clock ─── */
  .row-top {
    display: flex;
    align-items: flex-start;
    gap: 0;
  }

  .straf-col {
    flex: 0 0 60px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .straf-title {
    font-size: 7px;
    font-weight: 800;
    letter-spacing: 1.5px;
    color: var(--txt-dim);
    text-transform: uppercase;
  }
  .straf-box {
    width: 46px;
    height: 18px;
    border-radius: 2px;
    background: #0a0a0a;
    border: 1px solid #1a1a1a;
  }

  .clock-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .team-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    width: 100%;
  }

  .team-name {
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 3px;
    min-width: 46px;
  }
  .home-c { color: var(--home); text-align: right; }
  .away-c { color: var(--away); text-align: left; }

  .clock {
    font-size: 26px;
    font-weight: 900;
    color: var(--txt);
    letter-spacing: 2px;
    text-shadow: 0 0 14px rgba(255,255,255,0.3);
    font-variant-numeric: tabular-nums;
    min-width: 80px;
    text-align: center;
  }
  .live .clock {
    text-shadow: 0 0 18px rgba(255,255,255,0.45);
  }

  /* ─── Row 2: Blocks + Score ─── */
  .row-score {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
  }

  /* Period block columns */
  .pblocks-col {
    flex: 0 0 42px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
  }

  .led-block {
    width: 38px;
    height: 26px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .led-block.home.on {
    background: var(--home);
    box-shadow: 0 0 8px rgba(0,102,204,0.5), inset 0 1px 0 rgba(255,255,255,0.15);
  }
  .led-block.home.off {
    background: var(--home-dim);
    border: 1px solid rgba(0,102,204,0.2);
  }
  .led-block.away.on {
    background: var(--away);
    box-shadow: 0 0 8px rgba(204,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15);
  }
  .led-block.away.off {
    background: var(--away-dim);
    border: 1px solid rgba(204,0,0,0.2);
  }

  .led-val {
    font-size: 16px;
    font-weight: 900;
    color: var(--txt);
    text-shadow: 0 0 4px rgba(255,255,255,0.3);
  }
  .led-block.off .led-val {
    color: rgba(255,255,255,0.1);
  }

  /* Score center */
  .score-col {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .score-display {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .score-digit {
    font-size: 72px;
    font-weight: 900;
    color: var(--txt);
    line-height: 1;
    min-width: 50px;
    text-align: center;
    text-shadow:
      0 0 18px rgba(255,255,255,0.25),
      0 0 40px rgba(255,255,255,0.08);
  }
  .live .score-digit {
    text-shadow:
      0 0 22px rgba(255,255,255,0.35),
      0 0 50px rgba(255,255,255,0.12);
  }

  .period-circle {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: #333;
    border: 2px solid #555;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 900;
    color: var(--txt);
    flex-shrink: 0;
    margin: 0 2px;
  }
  .period-circle.active {
    background: var(--away);
    border-color: #ff4444;
    box-shadow: 0 0 12px rgba(204,0,0,0.6);
  }

  .future-display {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .future-vs {
    font-size: 40px;
    font-weight: 900;
    color: var(--txt-dim);
    letter-spacing: 6px;
  }

  /* ─── Goal ticker ─── */
  .ticker {
    text-align: center;
    padding: 5px 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--txt);
    background: linear-gradient(90deg, transparent, rgba(0,102,204,0.12), transparent);
    border-radius: 3px;
    letter-spacing: 0.3px;
    animation: ticker-pop 2s ease-out;
  }
  @keyframes ticker-pop {
    0%   { background: linear-gradient(90deg, transparent, rgba(0,102,204,0.5), transparent); }
    100% { background: linear-gradient(90deg, transparent, rgba(0,102,204,0.12), transparent); }
  }
  .ticker strong { font-weight: 800; }
  .ticker-siren { margin-right: 4px; }
  .ticker-time { color: rgba(255,255,255,0.4); margin-left: 6px; }

  /* ─── Red LED ring (bottom banner) ─── */
  .led-ring {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 9px 16px;
    background: linear-gradient(180deg,
      var(--ring-dark) 0%,
      var(--ring-red) 30%,
      var(--ring-red) 70%,
      var(--ring-dark) 100%
    );
    border-top: 1px solid #ee2222;
  }
  .led-ring.glow {
    animation: ring-pulse 2.5s ease-in-out infinite;
  }
  @keyframes ring-pulse {
    0%,100% { filter: brightness(0.85); }
    50%     { filter: brightness(1.1); }
  }

  .led-text {
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 5px;
    color: var(--txt);
    text-transform: uppercase;
    text-shadow: 0 0 10px rgba(255,255,255,0.5);
  }

  /* ─── Standby ─── */
  .standby .panel { min-height: 150px; justify-content: center; }
  .standby-text {
    text-align: center;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 4px;
    color: var(--txt-dim);
  }
`;

customElements.define('adler-mannheim-scoreboard', AdlerMannheimScoreboard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'adler-mannheim-scoreboard',
  name: 'Adler Mannheim Scoreboard',
  description: 'SAP Arena Videowürfel Scoreboard',
  preview: true,
});

console.info(
  `%c ADLER-SCOREBOARD %c v${CARD_VERSION} `,
  'background:#CC0000;color:#fff;font-weight:bold;padding:2px 8px;border-radius:4px 0 0 4px',
  'background:#222;color:#fff;padding:2px 8px;border-radius:0 4px 4px 0'
);
