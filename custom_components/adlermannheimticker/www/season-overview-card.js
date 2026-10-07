const CARD_VERSION = '9.0.0';

/* The club's own typefaces and palette, taken from its website. The font
   files are served with Access-Control-Allow-Origin: *, so a card may load
   them directly. */
const FONT_BASE = 'https://www.adler-mannheim.de/_resources/themes/homepage/css/fonts';

const BRAND = {
  /* The cube keeps these apart: the surrounding faces glow navy, the display
     surfaces themselves are near black. So the card body is the dark panel
     and the navy key visual stays in the head band. */
  panel: '#0d1013',
  navy: '#00264d',
  red: '#e50026',
  lightBlue: '#80a7cc',
  background: 'https://s3.adler-mannheim.de/public/Backgrounds/adler-mannheim-del-2.svg',
};

const DEFAULT_ENTITIES = {
  entity_season: 'sensor.adler_mannheim_season',
  entity_competitions: 'sensor.adler_mannheim_competitions',
  entity_standings: 'sensor.adler_mannheim_standings',
  entity_playoff: 'sensor.adler_mannheim_playoff',
  entity_scorer: 'sensor.adler_mannheim_top_scorer',
  entity_goalie: 'sensor.adler_mannheim_goalie',
};

const RESULT_LABELS = {
  W: 'S',
  OTW: 'SV',
  OTL: 'NV',
  L: 'N',
};

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

function signed(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${number}` : String(number);
}

class AdlerSeasonOverview extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._tab = 'form';
    this._signature = '';
  }

  setConfig(config) {
    this._config = { ...DEFAULT_ENTITIES, ...(config || {}) };
  }

  static getStubConfig() {
    return { ...DEFAULT_ENTITIES };
  }

  getCardSize() {
    return 6;
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _state(key) {
    if (!this._hass || !this._config[key]) {
      return null;
    }
    return this._hass.states[this._config[key]] || null;
  }

  _attrs(key) {
    const state = this._state(key);
    return state ? state.attributes || {} : {};
  }

  _render() {
    const season = this._state('entity_season');
    if (!season) {
      this.innerHTML = '<ha-card><div class="empty">Saisondaten nicht verfügbar</div></ha-card>';
      return;
    }

    const competitions = this._attrs('entity_competitions');
    const signature = [
      season.state,
      competitions.games_played,
      this._state('entity_standings') ? this._state('entity_standings').state : '',
      this._tab,
    ].join('|');

    if (signature === this._signature) {
      return;
    }
    this._signature = signature;

    this.innerHTML = `
      <ha-card>
        <style>${this._styles()}</style>
        ${this._renderHeader()}
        ${this._renderCompetitionTiles()}
        ${this._renderTabs()}
        <div class="tab-body">${this._renderTabBody()}</div>
      </ha-card>`;

    this.querySelectorAll('[data-tab]').forEach((node) => {
      node.addEventListener('click', () => {
        this._tab = node.getAttribute('data-tab');
        this._signature = '';
        this._render();
      });
    });
  }

  _renderHeader() {
    const seasonAttrs = this._attrs('entity_season');
    const standings = this._state('entity_standings');
    const rank = seasonAttrs.official_rank || (standings ? standings.state : null);
    const standingsAttrs = this._attrs('entity_standings');

    return `
      <div class="head">
        <div class="head-bg"></div>
        <div class="head-scrim"></div>
        <div class="head-rank">
          <span class="rank-value">${escapeHtml(rank || '?')}</span>
          <span class="rank-label">Platz</span>
        </div>
        <div class="head-main">
          <div class="head-title">DEL Hauptrunde</div>
          <div class="head-sub">
            ${escapeHtml(seasonAttrs.points ?? 0)} Punkte aus ${escapeHtml(seasonAttrs.games_played ?? 0)} Spielen
          </div>
          ${standingsAttrs.playoff_cut_legend
            ? `<div class="head-note">${escapeHtml(standingsAttrs.playoff_cut_legend)}</div>`
            : ''}
        </div>
        <div class="head-diff">
          <span class="diff-value ${(seasonAttrs.goal_diff || 0) >= 0 ? 'good' : 'bad'}">
            ${escapeHtml(signed(seasonAttrs.goal_diff))}
          </span>
          <span class="diff-label">${escapeHtml(seasonAttrs.goals_for ?? 0)}:${escapeHtml(seasonAttrs.goals_against ?? 0)}</span>
        </div>
      </div>`;
  }

  /* One tile per competition, so the CHL campaign shows up next to the league
     instead of being dropped from the season numbers entirely. */
  _renderCompetitionTiles() {
    const competitions = this._attrs('entity_competitions').competitions || {};
    const keys = Object.keys(competitions);
    if (!keys.length) {
      return '';
    }

    return `
      <div class="tiles">
        ${keys.map((key) => {
          const entry = competitions[key];
          return `
            <div class="tile">
              <div class="tile-title">${escapeHtml(entry.title || key)}</div>
              <div class="tile-record">${escapeHtml(entry.record || '')}</div>
              <div class="tile-meta">
                ${escapeHtml(entry.goals_for ?? 0)}:${escapeHtml(entry.goals_against ?? 0)}
                · ${escapeHtml(signed(entry.goal_diff))}
              </div>
            </div>`;
        }).join('')}
      </div>`;
  }

  _renderTabs() {
    const tabs = [
      ['form', 'Form'],
      ['table', 'Tabelle'],
      ['players', 'Spieler'],
    ];
    return `
      <div class="tabs">
        ${tabs.map(([key, label]) => `
          <button class="tab ${this._tab === key ? 'active' : ''}" data-tab="${key}">
            ${escapeHtml(label)}
          </button>`).join('')}
      </div>`;
  }

  _renderTabBody() {
    if (this._tab === 'table') {
      return this._renderTable();
    }
    if (this._tab === 'players') {
      return this._renderPlayers();
    }
    return this._renderForm();
  }

  _renderForm() {
    const competitions = this._attrs('entity_competitions');
    const seasonAttrs = this._attrs('entity_season');
    const results = (competitions.results || []).slice(-10).reverse();

    const chips = (competitions.last_5 || seasonAttrs.last_5 || [])
      .map((result) => `<span class="chip ${result.toLowerCase()}">${escapeHtml(RESULT_LABELS[result] || result)}</span>`)
      .join('');

    const rows = results.map((entry) => `
      <div class="res-row">
        <span class="res-badge ${entry.result.toLowerCase()}">${escapeHtml(RESULT_LABELS[entry.result] || entry.result)}</span>
        <span class="res-opponent">${entry.is_home ? '' : '@ '}${escapeHtml(entry.opponent || '?')}</span>
        <span class="res-comp">${escapeHtml(entry.competition || '')}</span>
        <span class="res-score">${escapeHtml(entry.score || '')}</span>
      </div>`).join('');

    return `
      <div class="form-head">
        <span class="form-label">Letzte 5</span>
        <span class="chips">${chips}</span>
        <span class="streak">Serie ${escapeHtml(competitions.streak || seasonAttrs.streak || '-')}</span>
      </div>
      <div class="res-list">${rows || '<div class="empty">Keine Ergebnisse</div>'}</div>
      <div class="split">
        <div><span class="split-key">Heim</span><span class="split-val">${escapeHtml(seasonAttrs.home_record || '-')}</span></div>
        <div><span class="split-key">Auswärts</span><span class="split-val">${escapeHtml(seasonAttrs.away_record || '-')}</span></div>
        <div><span class="split-key">Siegquote</span><span class="split-val">${escapeHtml(seasonAttrs.win_pct ?? 0)}%</span></div>
      </div>`;
  }

  _renderTable() {
    const standings = this._attrs('entity_standings');
    const teams = standings.teams || [];
    if (!teams.length) {
      return '<div class="empty">Tabelle nicht verfügbar</div>';
    }

    const playoffCut = standings.playoff_cut || 0;
    const qualificationCut = standings.qualification_cut || 0;

    return `
      <table class="table">
        <thead>
          <tr><th>#</th><th>Team</th><th>Sp</th><th>Diff</th><th>Pkt</th></tr>
        </thead>
        <tbody>
          ${teams.map((team) => {
            const classes = [
              team.is_adler ? 'adler' : '',
              playoffCut && team.rank <= playoffCut ? 'playoff' : '',
              qualificationCut && team.rank > playoffCut && team.rank <= qualificationCut ? 'quali' : '',
            ].filter(Boolean).join(' ');
            return `
              <tr class="${classes}">
                <td class="t-rank">${escapeHtml(team.rank)}</td>
                <td class="t-name">
                  ${team.logo ? `<img class="t-logo" src="${escapeHtml(team.logo)}" alt="" onerror="this.remove()"/>` : ''}
                  <span>${escapeHtml(team.short || team.name)}</span>
                </td>
                <td>${escapeHtml(team.games_played)}</td>
                <td class="${team.goal_diff >= 0 ? 'good' : 'bad'}">${escapeHtml(signed(team.goal_diff))}</td>
                <td class="t-points">${escapeHtml(team.points)}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${standings.updated ? `<div class="table-note">Stand ${escapeHtml(standings.updated)}</div>` : ''}`;
  }

  _renderPlayers() {
    const scorerAttrs = this._attrs('entity_scorer');
    const goalieAttrs = this._attrs('entity_goalie');
    const scorers = (scorerAttrs.top_scorers || []).slice(0, 6);
    const goalies = goalieAttrs.goalies || [];

    if (!scorers.length && !goalies.length) {
      return '<div class="empty">Spielerdaten nicht verfügbar</div>';
    }

    const scorerRows = scorers.map((player, index) => `
      <div class="pl-row">
        <span class="pl-pos">${index + 1}</span>
        ${player.photo ? `<img class="pl-photo" src="${escapeHtml(player.photo)}" alt="" onerror="this.remove()"/>` : ''}
        <span class="pl-name">
          <span>${escapeHtml(player.name || '')}</span>
          <span class="pl-meta">#${escapeHtml(player.jersey || '')} · ${escapeHtml(player.position || '')}</span>
        </span>
        <span class="pl-stat">${escapeHtml(player.points ?? 0)}<span class="pl-unit">P</span></span>
        <span class="pl-sub">${escapeHtml(player.goals ?? 0)}T / ${escapeHtml(player.assists ?? 0)}A</span>
      </div>`).join('');

    const goalieRows = goalies.map((player) => `
      <div class="pl-row">
        ${player.photo ? `<img class="pl-photo" src="${escapeHtml(player.photo)}" alt="" onerror="this.remove()"/>` : ''}
        <span class="pl-name">
          <span>${escapeHtml(player.name || '')}</span>
          <span class="pl-meta">#${escapeHtml(player.jersey || '')} · ${escapeHtml(player.gamesplayed ?? 0)} Spiele</span>
        </span>
        <span class="pl-stat">${escapeHtml(player.savepercentage ?? 0)}<span class="pl-unit">%</span></span>
        <span class="pl-sub">GAA ${escapeHtml(player.goalsagainstaverage ?? 0)}</span>
      </div>`).join('');

    return `
      ${scorerRows ? `<div class="pl-head">Topscorer</div><div class="pl-list">${scorerRows}</div>` : ''}
      ${goalieRows ? `<div class="pl-head">Torhüter</div><div class="pl-list">${goalieRows}</div>` : ''}`;
  }

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
        --am-base: ${BRAND.panel};
        --am-accent: ${BRAND.red};
        --am-ink: #ffffff;
        --am-muted: rgba(255, 255, 255, 0.6);
        --am-line: rgba(255, 255, 255, 0.14);
        --am-sunken: rgba(0, 0, 0, 0.34);
        background: var(--am-base);
        color: var(--am-ink);
        padding: 0;
        overflow: hidden;
        border: none;
        font-family: 'AM 72', system-ui, sans-serif;
      }
      .empty { padding: 26px; text-align: center; color: var(--am-muted); font-size: 12px; }

      /* The head carries the club's gameday key visual, the same graphic the
         scoreboard uses, so both cards read as one surface. */
      .head {
        position: relative;
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 12px;
        align-items: center;
        padding: 14px 14px 13px;
        overflow: hidden;
      }
      .head-bg {
        position: absolute;
        inset: 0;
        background-color: ${BRAND.navy};
        background-image: url('${BRAND.background}');
        background-size: cover;
        background-position: center;
      }
      .head-scrim {
        position: absolute;
        inset: 0;
        background: linear-gradient(100deg, rgba(0, 0, 0, 0.74) 0%, rgba(0, 0, 0, 0.3) 52%, rgba(0, 0, 0, 0.7) 100%);
      }
      .head > *:not(.head-bg):not(.head-scrim) { position: relative; }
      .head-rank { text-align: center; }
      .rank-value {
        display: block;
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 44px;
        line-height: 0.92;
        color: var(--am-accent);
        text-shadow: 0 0 22px rgba(0, 0, 0, 0.5);
      }
      .rank-label {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 8px;
        letter-spacing: 0.2em;
        color: var(--am-muted);
        text-transform: uppercase;
      }
      .head-title {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 18px;
        letter-spacing: 0.01em;
      }
      .head-sub { font-size: 11px; color: rgba(255, 255, 255, 0.78); margin-top: 2px; }
      .head-note {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 8px;
        letter-spacing: 0.14em;
        color: var(--am-muted);
        margin-top: 3px;
        text-transform: uppercase;
      }
      .head-diff { text-align: right; }
      .diff-value {
        display: block;
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 22px;
      }
      .diff-label {
        font-family: ui-monospace, monospace;
        font-size: 11px;
        color: var(--am-muted);
        font-variant-numeric: tabular-nums;
      }
      .good { color: #5ed267; }
      .bad { color: #ff5f6d; }

      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
        gap: 6px;
        padding: 10px 14px 0;
      }
      .tile {
        background: var(--am-sunken);
        border: 1px solid var(--am-line);
        border-radius: 4px;
        padding: 7px 9px;
      }
      .tile-title {
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 8px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--am-muted);
      }
      .tile-record {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: 17px;
        margin-top: 2px;
      }
      .tile-meta {
        font-family: ui-monospace, monospace;
        font-size: 9px;
        color: var(--am-muted);
        margin-top: 1px;
        font-variant-numeric: tabular-nums;
      }
      .tabs { display: flex; gap: 5px; padding: 11px 14px 0; }
      .tab {
        flex: 1;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid var(--am-line);
        border-radius: 3px;
        color: var(--am-muted);
        font-family: 'AM Industry Inc', sans-serif;
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        padding: 7px 4px;
        cursor: pointer;
      }
      .tab.active {
        background: var(--am-accent);
        border-color: var(--am-accent);
        color: #fff;
      }
      .tab-body { padding: 11px 14px 14px; }
      .form-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      .form-label, .streak { font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--am-muted); }
      .streak { margin-left: auto; }
      .chips { display: flex; gap: 3px; }
      .chip {
        width: 20px;
        height: 20px;
        border-radius: 4px;
        display: grid;
        place-items: center;
        font-size: 10px;
        font-weight: 700;
        background: var(--am-line);
        color: rgba(255, 255, 255, 0.78);
      }
      .chip.w { background: #14532d; color: #86efac; }
      .chip.otw { background: #166534; color: #bbf7d0; }
      .chip.otl { background: #713f12; color: #fde68a; }
      .chip.l { background: #7f1d1d; color: #fca5a5; }
      .res-list { display: flex; flex-direction: column; gap: 2px; }
      .res-row {
        display: grid;
        grid-template-columns: 24px 1fr auto auto;
        gap: 6px;
        align-items: center;
        font-size: 11px;
        padding: 3px 0;
        border-bottom: 1px solid var(--am-line);
      }
      .res-badge {
        width: 20px;
        height: 18px;
        border-radius: 4px;
        display: grid;
        place-items: center;
        font-size: 9px;
        font-weight: 700;
        background: var(--am-line);
        color: rgba(255, 255, 255, 0.78);
      }
      .res-badge.w { background: #14532d; color: #86efac; }
      .res-badge.otw { background: #166534; color: #bbf7d0; }
      .res-badge.otl { background: #713f12; color: #fde68a; }
      .res-badge.l { background: #7f1d1d; color: #fca5a5; }
      .res-opponent { color: var(--am-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .res-comp { font-size: 8px; color: var(--am-muted); letter-spacing: 0.08em; }
      .res-score { font-family: ui-monospace, monospace; color: var(--am-ink); }
      .split {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid var(--am-line);
      }
      .split div { display: flex; flex-direction: column; align-items: center; }
      .split-key { font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--am-muted); }
      .split-val { font-family: ui-monospace, monospace; font-size: 13px; color: var(--am-ink); }
      .table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .table th {
        font-size: 8px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--am-muted);
        text-align: right;
        padding: 3px 4px;
        border-bottom: 1px solid var(--am-line);
      }
      .table th:nth-child(2) { text-align: left; }
      .table td { padding: 3px 4px; text-align: right; color: var(--am-ink); }
      .table tr.adler { background: rgba(255, 77, 77, 0.12); }
      .table tr.adler .t-name span { color: var(--am-accent); font-weight: 700; }
      .t-rank { color: var(--am-muted); font-family: ui-monospace, monospace; }
      tr.playoff .t-rank { border-left: 2px solid #4ade80; }
      tr.quali .t-rank { border-left: 2px solid var(--am-lightblue, #80a7cc); }
      .t-name { text-align: left; display: flex; align-items: center; gap: 5px; }
      .t-logo { width: 16px; height: 16px; object-fit: contain; }
      .t-points { font-family: ui-monospace, monospace; font-weight: 700; color: var(--am-ink); }
      .table-note { font-size: 8px; color: var(--am-muted); margin-top: 6px; text-align: right; }
      .pl-head {
        font-size: 8px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--am-muted);
        margin: 8px 0 4px;
      }
      .pl-list { display: flex; flex-direction: column; gap: 3px; }
      .pl-row {
        display: grid;
        grid-template-columns: auto auto 1fr auto auto;
        gap: 6px;
        align-items: center;
        padding: 3px 0;
        border-bottom: 1px solid var(--am-line);
      }
      .pl-pos { font-family: ui-monospace, monospace; font-size: 10px; color: var(--am-muted); width: 12px; }
      .pl-photo { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; background: var(--am-line); }
      .pl-name { display: flex; flex-direction: column; overflow: hidden; }
      .pl-name > span:first-child {
        font-size: 11px;
        color: var(--am-ink);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pl-meta { font-size: 8px; color: var(--am-muted); }
      .pl-stat { font-family: ui-monospace, monospace; font-size: 14px; color: var(--am-ink); }
      .pl-unit { font-size: 8px; color: var(--am-muted); margin-left: 1px; }
      .pl-sub { font-size: 9px; color: var(--am-muted); white-space: nowrap; }
      /* Every label runs in the club's display face, every number in a
         tabular monospace, so columns line up the way a board does. */
      .form-label,
      .streak,
      .split-key,
      .res-comp,
      .pl-head,
      .pl-meta,
      .table th,
      .table-note {
        font-family: 'AM Industry Inc', sans-serif;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .res-score,
      .split-val,
      .t-rank,
      .t-points,
      .pl-stat,
      .pl-pos,
      .table td {
        font-variant-numeric: tabular-nums;
      }
      .res-badge,
      .chip,
      .tile-record,
      .pl-stat,
      .split-val {
        font-family: 'AM Industry', sans-serif;
        font-style: italic;
        font-weight: 900;
      }
      .table tr.adler { background: rgba(229, 0, 38, 0.16); }
      .table tr.adler .t-name span { color: #ff8094; font-weight: 700; }
      tr.playoff .t-rank { border-left: 2px solid #5ed267; }

      @media (max-width: 400px) {
        .res-comp { display: none; }
        .pl-sub { display: none; }
      }`;
  }
}

customElements.define('adler-season-overview', AdlerSeasonOverview);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'adler-season-overview',
  name: 'Adler Mannheim Saison',
  description: `Saisonbilanz, Tabelle und Spielerwerte (v${CARD_VERSION})`,
  preview: false,
});
