const SOC_VERSION = '1.0.0';

class AdlerSeasonOverview extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    this._config = config;
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    let changed = !prev;
    if (!changed) {
      for (const id of Object.keys(hass.states)) {
        if (!id.startsWith('sensor.adler_mannheim')) continue;
        const o = prev.states[id]; const n = hass.states[id];
        if (!o || !n || o.state !== n.state || o.last_updated !== n.last_updated) { changed = true; break; }
      }
    }
    if (changed) this._render();
  }

  getCardSize() { return 4; }
  static getStubConfig() { return {}; }

  _findEntity(prefix) {
    if (!this._hass) return null;
    for (const [id, s] of Object.entries(this._hass.states)) {
      if (id.startsWith(prefix) && s.state && !['None','unavailable','unknown'].includes(s.state)) return s;
    }
    return null;
  }

  _render() {
    if (!this._hass) return;

    const season = this._findEntity('sensor.adler_mannheim_season');
    const playoff = this._findEntity('sensor.adler_mannheim_playoff');
    const stats = this._findEntity('sensor.adler_mannheim_game_stats');

    this.shadowRoot.innerHTML = `
      <ha-card>
        <style>${SOC_STYLES}</style>
        <div class="card">
          <div class="header">
            <span class="title">ADLER MANNHEIM</span>
            <span class="subtitle">SAISON 2025/26</span>
          </div>
          ${season ? this._renderSeason(season.attributes) : '<div class="empty">Keine Saisondaten</div>'}
          ${playoff ? this._renderPlayoff(playoff.attributes) : ''}
          ${stats && stats.attributes ? this._renderStats(stats.attributes) : ''}
        </div>
      </ha-card>`;
  }

  _renderSeason(a) {
    const total = (a.wins || 0) + (a.losses || 0) + (a.otl || 0);
    const wPct = total ? (a.wins / total * 100) : 0;
    const lPct = total ? (a.losses / total * 100) : 0;
    const oPct = total ? (a.otl / total * 100) : 0;

    // Last 5 dots
    const last5 = (a.last_5 || []).map(r => {
      const cls = r === 'W' ? 'dot-w' : r === 'L' ? 'dot-l' : 'dot-otl';
      return `<span class="result-dot ${cls}" title="${r}"></span>`;
    }).join('');

    return `
      <div class="section">
        <!-- Points + Record -->
        <div class="top-row">
          <div class="points-box">
            <span class="points-num">${a.points || 0}</span>
            <span class="points-label">PUNKTE</span>
          </div>
          <div class="record-box">
            <div class="record-main">${a.wins || 0}S - ${a.losses || 0}N - ${a.otl || 0}V</div>
            <div class="record-sub">${a.games_played || 0} Spiele</div>
          </div>
          <div class="streak-box">
            <span class="streak-val">${a.streak || '-'}</span>
            <span class="streak-label">STREAK</span>
          </div>
        </div>

        <!-- W/L bar -->
        <div class="wl-bar">
          <div class="wl-seg wl-w" style="width:${wPct}%"></div>
          <div class="wl-seg wl-otl" style="width:${oPct}%"></div>
          <div class="wl-seg wl-l" style="width:${lPct}%"></div>
        </div>

        <!-- Stats grid -->
        <div class="stats-grid">
          <div class="stat">
            <span class="stat-val">${a.goals_for || 0}</span>
            <span class="stat-label">Tore</span>
          </div>
          <div class="stat">
            <span class="stat-val">${a.goals_against || 0}</span>
            <span class="stat-label">Gegentore</span>
          </div>
          <div class="stat">
            <span class="stat-val ${(a.goal_diff || 0) > 0 ? 'positive' : 'negative'}">${(a.goal_diff || 0) > 0 ? '+' : ''}${a.goal_diff || 0}</span>
            <span class="stat-label">Differenz</span>
          </div>
          <div class="stat">
            <span class="stat-val">${a.win_pct || 0}%</span>
            <span class="stat-label">Siegquote</span>
          </div>
        </div>

        <!-- Home/Away + Last 5 -->
        <div class="bottom-row">
          <div class="split">
            <span class="split-icon">🏠</span>
            <span class="split-val">${a.home_record || '-'}</span>
          </div>
          <div class="split">
            <span class="split-icon">✈️</span>
            <span class="split-val">${a.away_record || '-'}</span>
          </div>
          <div class="last5">
            <span class="last5-label">FORM</span>
            ${last5}
          </div>
        </div>
      </div>`;
  }

  _renderPlayoff(a) {
    if (!a || !a.opponent) return '';
    const wins_needed = Math.floor((a.best_of || 7) / 2) + 1;

    // Progress dots
    const adlerDots = Array.from({length: wins_needed}, (_, i) =>
      `<span class="po-dot ${i < (a.adler_wins || 0) ? 'po-filled-a' : 'po-empty'}"></span>`
    ).join('');
    const oppDots = Array.from({length: wins_needed}, (_, i) =>
      `<span class="po-dot ${i < (a.opponent_wins || 0) ? 'po-filled-o' : 'po-empty'}"></span>`
    ).join('');

    // Series games
    const gamesHtml = (a.games || []).map((g, i) =>
      `<span class="po-game ${g.won ? 'po-win' : 'po-loss'}" title="Spiel ${i+1}: ${g.score}">${g.score}</span>`
    ).join('');

    return `
      <div class="section po-section">
        <div class="section-title">PLAYOFF · Best of ${a.best_of || 7}</div>
        <div class="po-matchup">
          <div class="po-team">
            <span class="po-name po-a">ADLER</span>
            <div class="po-dots">${adlerDots}</div>
            <span class="po-score">${a.adler_wins || 0}</span>
          </div>
          <span class="po-vs">:</span>
          <div class="po-team">
            <span class="po-score">${a.opponent_wins || 0}</span>
            <div class="po-dots">${oppDots}</div>
            <span class="po-name po-o">${(a.opponent || '?').split(' ').pop()}</span>
          </div>
        </div>
        ${gamesHtml ? `<div class="po-games">${gamesHtml}</div>` : ''}
      </div>`;
  }

  _renderStats(a) {
    if (!a.shots_adler && !a.shots_opponent) return '';

    const bars = [
      ['Schüsse', a.shots_adler || 0, a.shots_opponent || 0],
      ['Faceoff %', a.faceoff_pct_adler || 0, a.faceoff_pct_opponent || 0],
      ['Strafmin.', a.pim_adler || 0, a.pim_opponent || 0],
      ['Saves', a.saves_adler || 0, a.saves_opponent || 0],
    ];

    const barsHtml = bars.map(([label, adler, opp]) => {
      const total = (adler || 0) + (opp || 0);
      const aPct = total ? (adler / total * 100) : 50;
      return `
        <div class="bar-row">
          <span class="bar-val bar-val-a">${adler}</span>
          <div class="bar-track">
            <div class="bar-fill bar-a" style="width:${aPct}%"></div>
          </div>
          <span class="bar-label">${label}</span>
          <div class="bar-track">
            <div class="bar-fill bar-o" style="width:${100-aPct}%"></div>
          </div>
          <span class="bar-val bar-val-o">${opp}</span>
        </div>`;
    }).join('');

    const pp = `PP: ${a.powerplay_adler || '0/0'} vs ${a.powerplay_opponent || '0/0'}`;
    const att = a.attendance ? `Zuschauer: ${a.attendance}` : '';

    return `
      <div class="section">
        <div class="section-title">SPIELSTATISTIK ${att ? `· ${att}` : ''}</div>
        <div class="bars">${barsHtml}</div>
        <div class="pp-line">${pp}</div>
      </div>`;
  }
}

const SOC_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :host {
    --home: #0066CC; --away: #CC0000; --otl: #cc9900;
    --bg: #0e0e14; --card: #141420; --border: #1e1e2a;
    --txt: #fff; --txt2: rgba(255,255,255,0.55); --txt3: rgba(255,255,255,0.28);
  }
  ha-card { background: var(--bg) !important; border: 1px solid var(--border) !important; border-radius: 10px !important; overflow: hidden; }
  .card { padding: 14px; font-family: 'Segoe UI',system-ui,sans-serif; }

  .header { text-align: center; margin-bottom: 12px; }
  .title { font-size: 13px; font-weight: 900; letter-spacing: 3px; color: var(--home); display: block; }
  .subtitle { font-size: 9px; font-weight: 700; letter-spacing: 2px; color: var(--txt3); }

  .section { background: var(--card); border-radius: 8px; padding: 10px; margin-bottom: 8px; border: 1px solid var(--border); }
  .section:last-child { margin-bottom: 0; }
  .section-title { font-size: 8px; font-weight: 800; letter-spacing: 2px; color: var(--txt3); margin-bottom: 8px; text-transform: uppercase; }

  .empty { text-align: center; padding: 20px; color: var(--txt3); font-size: 11px; letter-spacing: 2px; }

  /* Top row: Points + Record + Streak */
  .top-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .points-box { text-align: center; flex: 0 0 auto; }
  .points-num { font-size: 32px; font-weight: 900; color: var(--home); display: block; line-height: 1; text-shadow: 0 0 12px rgba(0,102,204,0.3); }
  .points-label { font-size: 7px; font-weight: 800; letter-spacing: 2px; color: var(--txt3); }
  .record-box { flex: 1; text-align: center; }
  .record-main { font-size: 16px; font-weight: 900; color: var(--txt); letter-spacing: 1px; }
  .record-sub { font-size: 9px; color: var(--txt3); }
  .streak-box { text-align: center; flex: 0 0 auto; }
  .streak-val { font-size: 20px; font-weight: 900; color: var(--txt); display: block; line-height: 1; }
  .streak-label { font-size: 7px; font-weight: 800; letter-spacing: 2px; color: var(--txt3); }

  /* W/L bar */
  .wl-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; margin-bottom: 10px; background: #1a1a2a; }
  .wl-seg { height: 100%; transition: width 0.5s; }
  .wl-w { background: var(--home); }
  .wl-otl { background: var(--otl); }
  .wl-l { background: var(--away); }

  /* Stats grid */
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
  .stat { text-align: center; padding: 6px 4px; background: rgba(255,255,255,0.02); border-radius: 6px; }
  .stat-val { font-size: 16px; font-weight: 900; color: var(--txt); display: block; }
  .stat-val.positive { color: #4caf50; }
  .stat-val.negative { color: var(--away); }
  .stat-label { font-size: 8px; color: var(--txt3); font-weight: 600; }

  /* Bottom row */
  .bottom-row { display: flex; align-items: center; gap: 8px; }
  .split { display: flex; align-items: center; gap: 4px; background: rgba(255,255,255,0.02); padding: 4px 8px; border-radius: 4px; }
  .split-icon { font-size: 10px; }
  .split-val { font-size: 11px; font-weight: 700; color: var(--txt2); }
  .last5 { margin-left: auto; display: flex; align-items: center; gap: 4px; }
  .last5-label { font-size: 8px; font-weight: 700; color: var(--txt3); letter-spacing: 1px; }
  .result-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot-w { background: var(--home); box-shadow: 0 0 4px rgba(0,102,204,0.4); }
  .dot-l { background: var(--away); box-shadow: 0 0 4px rgba(204,0,0,0.4); }
  .dot-otl { background: var(--otl); }

  /* Playoff */
  .po-section { border-color: rgba(0,102,204,0.3); }
  .po-matchup { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 6px; }
  .po-team { display: flex; align-items: center; gap: 6px; }
  .po-name { font-size: 11px; font-weight: 800; letter-spacing: 1px; }
  .po-a { color: var(--home); }
  .po-o { color: var(--away); }
  .po-score { font-size: 24px; font-weight: 900; color: var(--txt); }
  .po-vs { font-size: 16px; font-weight: 400; color: var(--txt3); }
  .po-dots { display: flex; gap: 4px; }
  .po-dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #333; }
  .po-filled-a { background: var(--home); border-color: var(--home); box-shadow: 0 0 6px rgba(0,102,204,0.5); }
  .po-filled-o { background: var(--away); border-color: var(--away); box-shadow: 0 0 6px rgba(204,0,0,0.5); }
  .po-empty { background: transparent; }
  .po-games { display: flex; gap: 4px; justify-content: center; flex-wrap: wrap; }
  .po-game { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
  .po-win { background: rgba(0,102,204,0.15); color: var(--home); }
  .po-loss { background: rgba(204,0,0,0.15); color: var(--away); }

  /* Game stats bars */
  .bars { display: flex; flex-direction: column; gap: 4px; }
  .bar-row { display: flex; align-items: center; gap: 4px; }
  .bar-val { font-size: 11px; font-weight: 800; min-width: 28px; text-align: center; }
  .bar-val-a { color: var(--home); }
  .bar-val-o { color: var(--away); }
  .bar-label { font-size: 8px; font-weight: 700; color: var(--txt3); min-width: 52px; text-align: center; letter-spacing: 0.5px; }
  .bar-track { flex: 1; height: 8px; background: #1a1a2a; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s; }
  .bar-a { background: var(--home); float: right; }
  .bar-o { background: var(--away); }
  .pp-line { font-size: 9px; color: var(--txt3); text-align: center; margin-top: 6px; }
`;

customElements.define('adler-season-overview', AdlerSeasonOverview);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'adler-season-overview', name: 'Adler Mannheim Saison', description: 'Season Overview + Playoffs + Game Stats', preview: true });
console.info(`%c ADLER-SEASON %c v${SOC_VERSION} `, 'background:#0066CC;color:#fff;font-weight:bold;padding:2px 8px;border-radius:4px 0 0 4px', 'background:#222;color:#fff;padding:2px 8px;border-radius:0 4px 4px 0');
