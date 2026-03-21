const CARD_VERSION = '1.0.0';

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

  getCardSize() {
    return 4;
  }

  static getStubConfig() {
    return { entity: 'sensor.adler_mannheim_aktuelles_spiel' };
  }

  /* ── Find the best entity to display ── */
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

  /* ── Main render ── */
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
      <div class="frame standby">
        <div class="top-strip"></div>
        <div class="header">SAP ARENA MANNHEIM</div>
        <div class="standby-msg">KEINE SPIELDATEN</div>
        <div class="bot-strip"></div>
      </div>`;
  }

  _renderGame({ state, mode }) {
    const a = state.attributes;
    const isLive = mode === 'live';
    const isNext = mode === 'next';
    const homeScore = a.score_home ?? 0;
    const awayScore = a.score_away ?? 0;

    return `
      <div class="frame ${mode}">
        <div class="top-strip"></div>

        <!-- Header -->
        <div class="header">
          <span class="arena">SAP ARENA</span>
          ${a.competition ? `<span class="comp">${a.competition}</span>` : ''}
        </div>

        <!-- Status -->
        ${this._renderStatus(mode)}

        <!-- Score area -->
        <div class="score-area">
          ${this._renderTeam(a.home_team, a.home_team_short, a.home_logo, 'home')}

          <div class="center">
            ${isNext
              ? `<div class="vs">VS</div><div class="kickoff">${state.state || ''}</div>`
              : `<div class="digits">
                   <span class="num">${homeScore}</span>
                   <span class="colon ${isLive ? 'blink' : ''}">:</span>
                   <span class="num">${awayScore}</span>
                 </div>`
            }
          </div>

          ${this._renderTeam(a.away_team, a.away_team_short, a.away_logo, 'away')}
        </div>

        <!-- Period scores -->
        ${this._renderPeriods(a)}

        <!-- Last goal ticker -->
        ${isLive ? this._renderLastGoal(a) : ''}

        <div class="bot-strip"></div>
      </div>`;
  }

  _renderStatus(mode) {
    if (mode === 'live')
      return `<div class="badge live-badge"><span class="dot"></span>LIVE</div>`;
    if (mode === 'next')
      return `<div class="badge dim">NÄCHSTES SPIEL</div>`;
    return `<div class="badge dim">ENDERGEBNIS</div>`;
  }

  _renderTeam(name, short, logo, side) {
    const abbr = (short || (name || '???').substring(0, 3)).toUpperCase();
    const logoHtml = logo
      ? `<img class="logo" src="${logo}" alt="${name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
         <div class="logo-fb" style="display:none">${abbr}</div>`
      : `<div class="logo-fb">${abbr}</div>`;

    return `
      <div class="team ${side}">
        <div class="logo-wrap">${logoHtml}</div>
        <div class="tname">${name || '???'}</div>
      </div>`;
  }

  _renderPeriods(a) {
    const parts = [];
    for (let i = 1; i <= 3; i++) {
      if (a[`period_${i}`]) parts.push({ l: `${i}. D`, v: a[`period_${i}`] });
    }
    if (a.overtime) parts.push({ l: 'OT', v: a.overtime });
    if (a.shootout) parts.push({ l: 'SO', v: a.shootout });
    if (!parts.length) return '';

    return `
      <div class="periods">
        ${parts.map(p => `
          <div class="pd">
            <span class="pd-v">${p.v}</span>
            <span class="pd-l">${p.l}</span>
          </div>`).join('<div class="pd-div"></div>')}
      </div>`;
  }

  _renderLastGoal(a) {
    const goals = a.goals;
    if (!goals || !goals.length) return '';
    const g = goals[goals.length - 1];
    if (!g.scorer) return '';
    const assists = [g.assist1, g.assist2].filter(Boolean).join(', ');

    return `
      <div class="ticker">
        <span class="siren">🚨</span>
        <span class="ticker-txt">
          <strong>${g.scorer}</strong>${assists ? ` &middot; ${assists}` : ''}
          <span class="ticker-time">${g.time || ''} ${g.type ? `(${g.type})` : ''}</span>
        </span>
      </div>`;
  }
}

/* ═══════════════════════════════════════════════
   CSS — SAP Arena Videowürfel aesthetic
   ═══════════════════════════════════════════════ */
const STYLES = `
  :host {
    --blue:        #00529C;
    --blue-dark:   #003366;
    --blue-glow:   rgba(0, 82, 156, 0.55);
    --bg:          #060a14;
    --bg-frame:    #0b1024;
    --bg-subtle:   rgba(255,255,255,0.03);
    --txt:         #ffffff;
    --txt2:        rgba(255,255,255,0.52);
    --txt3:        rgba(255,255,255,0.25);
    --red:         #ff1744;
    --border:      #162040;
  }

  ha-card {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
  }

  .cube { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }

  /* ── Outer frame ── */
  .frame {
    position: relative;
    background:
      radial-gradient(ellipse at 50% 0%, rgba(0,82,156,0.07) 0%, transparent 55%),
      linear-gradient(180deg, #0e1328 0%, var(--bg) 45%, #0e1328 100%);
    border: 2px solid var(--border);
    border-radius: 18px;
    padding: 0 24px 8px;
    overflow: hidden;
    box-shadow:
      0 6px 40px rgba(0,0,0,0.65),
      inset 0 1px 0 rgba(255,255,255,0.03);
  }

  .frame.live {
    border-color: rgba(0,82,156,0.45);
    box-shadow:
      0 6px 40px rgba(0,0,0,0.65),
      0 0 28px rgba(0,82,156,0.18),
      inset 0 1px 0 rgba(255,255,255,0.03);
  }

  .frame.standby { opacity: 0.55; }

  /* ── LED accent strips (top + bottom) ── */
  .top-strip, .bot-strip {
    height: 3px;
    margin: 0 -24px;
    background: linear-gradient(90deg, transparent 5%, var(--blue) 50%, transparent 95%);
    opacity: 0.35;
  }
  .frame.live .top-strip,
  .frame.live .bot-strip {
    opacity: 0.9;
    animation: pulse-strip 2.2s ease-in-out infinite;
  }
  @keyframes pulse-strip { 0%,100%{opacity:.45} 50%{opacity:1} }

  /* ── Header bar ── */
  .header {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 10px;
    padding: 10px 0 6px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .arena {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 3.5px;
    color: var(--txt3);
    text-transform: uppercase;
  }
  .comp {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 1.2px;
    color: var(--blue);
    background: rgba(0,82,156,0.12);
    padding: 2px 8px;
    border-radius: 4px;
  }

  /* ── Status badge ── */
  .badge {
    text-align: center;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    padding: 6px 0 2px;
  }
  .dim { color: var(--txt2); }

  .live-badge {
    color: var(--red);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
  }
  .dot {
    width: 9px; height: 9px;
    border-radius: 50%;
    background: var(--red);
    box-shadow: 0 0 10px var(--red), 0 0 20px rgba(255,23,68,0.35);
    animation: dot-beat 1.4s ease-in-out infinite;
  }
  @keyframes dot-beat {
    0%,100% { transform: scale(1);   opacity: 1; }
    50%     { transform: scale(0.75); opacity: 0.45; }
  }

  /* ── Score area ── */
  .score-area {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px 0 14px;
    gap: 0;
  }

  /* Team column */
  .team {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .logo-wrap {
    width: 68px; height: 68px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,0.045) 0%, transparent 72%);
  }
  .logo {
    max-width: 58px; max-height: 58px;
    object-fit: contain;
    filter: drop-shadow(0 0 10px rgba(255,255,255,0.12));
  }
  .logo-fb {
    width: 56px; height: 56px;
    border-radius: 50%;
    background: var(--bg-frame);
    border: 2px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    font-weight: 900;
    color: var(--txt2);
    letter-spacing: 1px;
  }
  .tname {
    font-size: 11px;
    font-weight: 700;
    color: var(--txt2);
    text-align: center;
    letter-spacing: 0.4px;
    max-width: 110px;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Center score */
  .center {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0 10px;
    min-width: 130px;
  }
  .digits {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .num {
    font-size: 60px;
    font-weight: 900;
    color: var(--txt);
    line-height: 1;
    min-width: 44px;
    text-align: center;
    text-shadow:
      0 0 22px var(--blue-glow),
      0 0 44px rgba(0,82,156,0.22);
  }
  .frame.live .num {
    text-shadow:
      0 0 22px var(--blue-glow),
      0 0 44px rgba(0,82,156,0.35),
      0 2px 6px rgba(0,0,0,0.5);
  }
  .colon {
    font-size: 44px;
    font-weight: 300;
    color: var(--txt2);
    line-height: 1;
    padding-bottom: 6px;
  }
  .blink { animation: blink-c 1s step-end infinite; }
  @keyframes blink-c { 0%,100%{opacity:1} 50%{opacity:.22} }

  .vs {
    font-size: 30px;
    font-weight: 900;
    color: var(--txt3);
    letter-spacing: 5px;
  }
  .kickoff {
    font-size: 17px;
    font-weight: 700;
    color: var(--blue);
    margin-top: 4px;
    letter-spacing: 1px;
  }

  /* ── Period bar ── */
  .periods {
    display: flex;
    justify-content: center;
    align-items: center;
    background: var(--bg-subtle);
    border: 1px solid rgba(255,255,255,0.035);
    border-radius: 10px;
    padding: 8px 20px;
    margin-bottom: 6px;
  }
  .pd {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0 18px;
    gap: 2px;
  }
  .pd-v {
    font-size: 15px;
    font-weight: 800;
    color: var(--txt);
    letter-spacing: 1px;
  }
  .pd-l {
    font-size: 9px;
    font-weight: 700;
    color: var(--txt3);
    text-transform: uppercase;
    letter-spacing: 1.2px;
  }
  .pd-div {
    width: 1px;
    height: 26px;
    background: rgba(255,255,255,0.07);
  }

  /* ── Goal ticker ── */
  .ticker {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 9px 12px;
    margin: 4px 0 6px;
    background: linear-gradient(90deg, transparent 2%, rgba(0,82,156,0.1) 50%, transparent 98%);
    border-radius: 8px;
    animation: flash-in 2.5s ease-out;
  }
  @keyframes flash-in {
    0%   { background: linear-gradient(90deg, transparent 2%, rgba(0,82,156,0.45) 50%, transparent 98%); }
    100% { background: linear-gradient(90deg, transparent 2%, rgba(0,82,156,0.1)  50%, transparent 98%); }
  }
  .siren { font-size: 16px; }
  .ticker-txt {
    font-size: 12px;
    font-weight: 600;
    color: var(--txt);
    letter-spacing: 0.2px;
  }
  .ticker-txt strong { font-weight: 800; }
  .ticker-time {
    color: var(--txt2);
    margin-left: 4px;
    font-weight: 500;
  }

  /* ── Standby ── */
  .standby-msg {
    padding: 48px 0;
    text-align: center;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 4px;
    color: var(--txt3);
  }
`;

/* ── Register element ── */
customElements.define('adler-mannheim-scoreboard', AdlerMannheimScoreboard);

/* ── Card picker ── */
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'adler-mannheim-scoreboard',
  name: 'Adler Mannheim Scoreboard',
  description: 'SAP Arena Videowürfel-Style Scoreboard für Adler Mannheim',
  preview: true,
});

console.info(
  `%c ADLER-SCOREBOARD %c v${CARD_VERSION} `,
  'background:#00529C;color:#fff;font-weight:bold;padding:2px 8px;border-radius:4px 0 0 4px',
  'background:#162040;color:#fff;padding:2px 8px;border-radius:0 4px 4px 0'
);
