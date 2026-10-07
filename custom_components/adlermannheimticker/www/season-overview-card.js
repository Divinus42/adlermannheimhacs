const CARD_VERSION = '3.0.0';

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
      ha-card {
        background: linear-gradient(160deg, #0a1628 0%, #06101d 100%);
        color: #e8eef7;
        padding: 12px;
        overflow: hidden;
      }
      .empty { padding: 24px; text-align: center; color: #5f7794; font-size: 12px; }
      .head {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 12px;
        align-items: center;
        padding-bottom: 10px;
        border-bottom: 1px solid #16283f;
      }
      .head-rank { text-align: center; }
      .rank-value {
        display: block;
        font-family: monospace;
        font-size: 30px;
        font-weight: 700;
        color: #ff4d4d;
        line-height: 1;
      }
      .rank-label { font-size: 8px; letter-spacing: 0.14em; color: #5f7794; text-transform: uppercase; }
      .head-title { font-size: 14px; font-weight: 700; }
      .head-sub { font-size: 11px; color: #9fb8d4; margin-top: 2px; }
      .head-note { font-size: 9px; color: #5f7794; margin-top: 2px; }
      .head-diff { text-align: right; }
      .diff-value { display: block; font-family: monospace; font-size: 17px; font-weight: 700; }
      .diff-label { font-size: 10px; color: #7f93ad; }
      .good { color: #4ade80; }
      .bad { color: #f87171; }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
        gap: 6px;
        margin-top: 10px;
      }
      .tile {
        background: #0b1626;
        border: 1px solid #16283f;
        border-radius: 8px;
        padding: 7px 8px;
      }
      .tile-title {
        font-size: 8px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #5f7794;
      }
      .tile-record { font-family: monospace; font-size: 15px; color: #ffcf3d; margin-top: 2px; }
      .tile-meta { font-size: 9px; color: #7f93ad; margin-top: 1px; }
      .tabs { display: flex; gap: 4px; margin-top: 12px; }
      .tab {
        flex: 1;
        background: #0b1626;
        border: 1px solid #16283f;
        border-radius: 6px;
        color: #7f93ad;
        font-size: 11px;
        padding: 6px 4px;
        cursor: pointer;
        font-family: inherit;
      }
      .tab.active { background: #16283f; color: #e8eef7; border-color: #2b4466; }
      .tab-body { margin-top: 10px; }
      .form-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      .form-label, .streak { font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: #5f7794; }
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
        background: #16283f;
        color: #9fb8d4;
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
        border-bottom: 1px solid rgba(22, 40, 63, 0.6);
      }
      .res-badge {
        width: 20px;
        height: 18px;
        border-radius: 4px;
        display: grid;
        place-items: center;
        font-size: 9px;
        font-weight: 700;
        background: #16283f;
        color: #9fb8d4;
      }
      .res-badge.w { background: #14532d; color: #86efac; }
      .res-badge.otw { background: #166534; color: #bbf7d0; }
      .res-badge.otl { background: #713f12; color: #fde68a; }
      .res-badge.l { background: #7f1d1d; color: #fca5a5; }
      .res-opponent { color: #cfe0f3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .res-comp { font-size: 8px; color: #5f7794; letter-spacing: 0.08em; }
      .res-score { font-family: monospace; color: #ffcf3d; }
      .split {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid #16283f;
      }
      .split div { display: flex; flex-direction: column; align-items: center; }
      .split-key { font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase; color: #5f7794; }
      .split-val { font-family: monospace; font-size: 13px; color: #e8eef7; }
      .table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .table th {
        font-size: 8px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #5f7794;
        text-align: right;
        padding: 3px 4px;
        border-bottom: 1px solid #16283f;
      }
      .table th:nth-child(2) { text-align: left; }
      .table td { padding: 3px 4px; text-align: right; color: #cfe0f3; }
      .table tr.adler { background: rgba(255, 77, 77, 0.12); }
      .table tr.adler .t-name span { color: #ff8080; font-weight: 700; }
      .t-rank { color: #7f93ad; font-family: monospace; }
      tr.playoff .t-rank { border-left: 2px solid #4ade80; }
      tr.quali .t-rank { border-left: 2px solid #60a5fa; }
      .t-name { text-align: left; display: flex; align-items: center; gap: 5px; }
      .t-logo { width: 16px; height: 16px; object-fit: contain; }
      .t-points { font-family: monospace; font-weight: 700; color: #ffcf3d; }
      .table-note { font-size: 8px; color: #3d5570; margin-top: 6px; text-align: right; }
      .pl-head {
        font-size: 8px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #5f7794;
        margin: 8px 0 4px;
      }
      .pl-list { display: flex; flex-direction: column; gap: 3px; }
      .pl-row {
        display: grid;
        grid-template-columns: auto auto 1fr auto auto;
        gap: 6px;
        align-items: center;
        padding: 3px 0;
        border-bottom: 1px solid rgba(22, 40, 63, 0.6);
      }
      .pl-pos { font-family: monospace; font-size: 10px; color: #5f7794; width: 12px; }
      .pl-photo { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; background: #16283f; }
      .pl-name { display: flex; flex-direction: column; overflow: hidden; }
      .pl-name > span:first-child {
        font-size: 11px;
        color: #e8eef7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pl-meta { font-size: 8px; color: #5f7794; }
      .pl-stat { font-family: monospace; font-size: 14px; color: #ffcf3d; }
      .pl-unit { font-size: 8px; color: #7f93ad; margin-left: 1px; }
      .pl-sub { font-size: 9px; color: #7f93ad; white-space: nowrap; }
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
