// - Storage -
const STORE_KEY = 'mlb_dfs_entries';
let entries = [];

function loadEntries() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}
function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(entries));
}

document.addEventListener('DOMContentLoaded', () => {
  entries = loadEntries();
  setupDrop();
  renderAll();
});

// - Helpers -
function g(id)  { return document.getElementById(id); }
function gv(id) { const e = g(id); return e ? e.value.trim() : ''; }

function todayISO() { return new Date().toISOString().split('T')[0]; }
function yesterdayISO() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function showAlert(id, msg, type = 'success') {
  const el = g(id); if (!el) return;
  const icon = type === 'success' ? 'check' : type === 'danger' ? 'alert-circle' : 'info-circle';
  el.innerHTML = `<div class="alert ${type}"><i class="ti ti-${icon}"></i>${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 6000);
}

function showTab(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  g('tab-' + name).classList.add('active');
  el.classList.add('active');
  if (name === 'dashboard') renderDashboard();
  if (name === 'history')   renderHistory();
}

// - Contest classifier -
// Returns 'Cash' or 'GPP' based on contest name and optional FD opponent field
function classifyContest(name, opponent) {
  const n = (name || '').toLowerCase();

  // FD: Opponent field is reliable - anything not "Tournament" is cash
  if (opponent && opponent.toLowerCase() !== 'tournament') return 'Cash';

  // DK: Only true cash contest is Double Up (top ~44-46% pay out)
  // Everything else - Solo Shot, Chin Music, Pickoff, Four-Seamer,
  // Hot Corner, Base Hit, Strike Three, Triple Up, Quintuple Up,
  // Satellites, Winner Take All - are all GPP formats
  if (/double.?up/i.test(n)) return 'Cash';

  // FD cash names
  if (/50.?50/i.test(n) || /fifty.?fifty/i.test(n)) return 'Cash';
  if (/head.?to.?head/i.test(n) || /\bh2h\b/i.test(n) || /\bduel\b/i.test(n)) return 'Cash';
  if (/\bbean ball\b/i.test(n)) return 'Cash'; // FD Double Up

  return 'GPP';
}

// Finer-grained contest type label
function contestType(name, opponent) {
  const n = (name || '').toLowerCase();
  if (/double.?up/i.test(n)) return 'Double Up';
  if (/\bbean ball\b/i.test(n)) return 'Double Up'; // FD
  if (/50.?50/i.test(n) || /fifty.?fifty/i.test(n)) return '50/50';
  if (/head.?to.?head/i.test(n) || /\bh2h\b/i.test(n) || /\bduel\b/i.test(n)) return 'H2H';
  if (opponent && opponent.toLowerCase() !== 'tournament') return 'Cash - Other';
  return 'GPP';
}

// - CSV parsing -
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVRow(lines[0]).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCSVRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim().replace(/^"|"$/g, ''); });
    return obj;
  });
}

function splitCSVRow(row) {
  const res = []; let cur = ''; let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if      (c === '"' && !inQ)                    { inQ = true; }
    else if (c === '"' && inQ && row[i+1] === '"') { cur += '"'; i++; }
    else if (c === '"' && inQ)                     { inQ = false; }
    else if (c === ',' && !inQ)                    { res.push(cur); cur = ''; }
    else                                            { cur += c; }
  }
  res.push(cur);
  return res;
}

function parseMoney(str) {
  return parseFloat((str || '0').replace(/[$, ]/g, '')) || 0;
}

function stripDKSuffix(name) {
  return name.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
}

function parseDKDate(str) {
  if (!str) return null;
  // Format: "2025-05-05 19:15:00" or "2025-05-05T19:15:00"
  const iso = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // Format: "6/1/2026 19:10"
  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return null;
}

function parseFDDate(str) {
  if (!str) return null;
  const iso = str.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return null;
}

function detectSite(headers) {
  const h = headers.join(',');
  if (h.includes('entry_key') || h.includes('contest_key') || h.includes('winnings_non_ticket')) return 'DK';
  if (h.includes('entry id')  || h.includes('salarycap')   || h.includes('salary cap'))         return 'FD';
  return null;
}

function normalizeDK(rows) {
  return rows
    .filter(r => (r['sport'] || '').toUpperCase() === 'MLB')
    .map(r => {
      const contest    = stripDKSuffix(r['entry'] || '');
      const pts        = parseFloat(r['points']) || 0;
      const rank       = parseInt(r['place']) || null;
      const win        = +(parseMoney(r['winnings_non_ticket']) + parseMoney(r['winnings_ticket'])).toFixed(2);
      const placesPaid = parseInt(r['places_paid']) || 0;
      const entries    = parseInt(r['contest_entries']) || null;
      const fee        = parseMoney(r['entry_fee']);
      const date       = parseDKDate(r['contest_date_est'] || '');
      const cashed     = placesPaid > 0 && rank !== null ? (rank <= placesPaid ? 'Y' : 'N') : (win > 0 ? 'Y' : 'N');
      const cls        = classifyContest(contest, null);
      const ctype      = contestType(contest, null);
      return { contest, pts, rank, win, entries, fee, date, cashed, cls, ctype };
    })
    .filter(r => r.contest);
}

function normalizeFD(rows) {
  return rows
    .filter(r => (r['sport'] || '').toLowerCase() === 'mlb')
    .map(r => {
      const contest  = (r['title'] || '').trim();
      const pts      = parseFloat(r['score']) || 0;
      const rank     = parseInt(r['position']) || null;
      const win      = parseMoney(r['winnings ($)']);
      const entries  = parseInt(r['entries']) || null;
      const fee      = parseMoney(r['entry ($)']);
      const date     = parseFDDate(r['date'] || '');
      const opponent = r['opponent'] || '';
      const cashed   = win > 0 ? 'Y' : 'N';
      const cls      = classifyContest(contest, opponent);
      const ctype    = contestType(contest, opponent);
      return { contest, pts, rank, win, entries, fee, date, cashed, cls, ctype };
    })
    .filter(r => r.contest);
}

// - Date filter helpers -
function setImportDateRange(preset) {
  const from = g('import-date-from'), to = g('import-date-to');
  if (!from || !to) return;
  if (preset === 'clear')     { from.value = ''; to.value = ''; return; }
  if (preset === 'today')     { from.value = todayISO();     to.value = todayISO();     return; }
  if (preset === 'yesterday') { from.value = yesterdayISO(); to.value = yesterdayISO(); return; }
  if (preset === 'week') {
    const d = new Date(); d.setDate(d.getDate() - 6);
    from.value = d.toISOString().split('T')[0];
    to.value   = todayISO();
  }
}

// - Import flow -
function setupDrop() {
  const dz = g('drop-zone'); if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); });
}


function renderPreview(rows, site) {
  pendingRows = rows;
  g('import-step1').style.display = 'none';
  g('import-step2').style.display = 'block';

  const gppCount  = rows.filter(r => r.cls === 'GPP').length;
  const cashCount = rows.filter(r => r.cls === 'Cash').length;
  const totalWin  = rows.reduce((a, r) => a + r.win, 0);
  const totalFee  = rows.reduce((a, r) => a + r.fee, 0);

  g('import-summary').innerHTML = `
    <h3>${site} - ${rows.length} lineup${rows.length !== 1 ? 's' : ''} ready to import</h3>
    <div class="summary-row"><span>GPP lineups</span><strong>${gppCount}</strong></div>
    <div class="summary-row"><span>Cash lineups</span><strong>${cashCount}</strong></div>
    <div class="summary-row"><span>Total entry fees</span><strong>$${totalFee.toFixed(2)}</strong></div>
    <div class="summary-row"><span>Total winnings</span><strong>$${totalWin.toFixed(2)}</strong></div>
    <div class="summary-row"><span>Net P/L</span><strong class="${totalWin - totalFee >= 0 ? 'pos' : 'neg'}">${totalWin - totalFee >= 0 ? '+' : ''}$${(totalWin - totalFee).toFixed(2)}</strong></div>`;

  // Preview table - first 15 rows
  const preview = rows.slice(0, 15);
  const moreRows = rows.length > 15 ? `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);font-size:11px;padding:8px">- and ${rows.length - 15} more</td></tr>` : '';
  g('preview-table').innerHTML = `
    <div class="table-wrap" style="margin:1rem 0">
      <table>
        <thead><tr><th>Date</th><th>Contest</th><th>Class</th><th>Score</th><th>Rank</th><th>Fee</th><th>Winnings</th></tr></thead>
        <tbody>
          ${preview.map(r => `<tr>
            <td>${r.date || '-'}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${r.contest}">${r.contest}</td>
            <td><span class="badge ${r.cls === 'Cash' ? 'cash' : 'gpp'}">${r.cls}</span></td>
            <td>${r.pts.toFixed(1)}</td>
            <td>${r.rank || '-'}</td>
            <td>$${r.fee.toFixed(2)}</td>
            <td class="${r.win > 0 ? 'pos' : ''}">${r.win > 0 ? '$' + r.win.toFixed(2) : '-'}</td>
          </tr>`).join('')}
          ${moreRows}
        </tbody>
      </table>
    </div>`;
}

function confirmImport() {
  let added = 0, dupes = 0;
  pendingRows.forEach(r => {
    // Deduplicate: same date + contest + score + rank
    const isDupe = entries.some(e =>
      e.date === r.date && e.contest === r.contest &&
      e.pts === r.pts   && e.rank   === r.rank
    );
    if (isDupe) { dupes++; return; }
    entries.unshift({
      id:      Date.now() + Math.random(),
      date:    r.date,
      site:    pendingRows._site || detectSiteFromRow(r),
      contest: r.contest,
      cls:     r.cls,
      ctype:   r.ctype,
      fee:     r.fee,
      invested: r.fee,
      pts:     r.pts,
      rank:    r.rank,
      field:   r.entries,
      cashed:  r.cashed,
      win:     r.win,
      pl:      +(r.win - r.fee).toFixed(2),
    });
    added++;
  });
  persist();
  renderAll();
  const msg = dupes > 0
    ? `Imported ${added} lineup${added !== 1 ? 's' : ''}. ${dupes} duplicate${dupes !== 1 ? 's' : ''} skipped.`
    : `Imported ${added} lineup${added !== 1 ? 's' : ''}.`;
  showAlert('import-alert', msg);
  resetImport();
}

// Site isn't stored on the row - infer from the file being processed
// We'll tag pendingRows with _site in handleFile
function detectSiteFromRow(r) { return r._site || ''; }

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) {
    showAlert('import-alert', 'Please upload a .csv file.', 'danger'); return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (!rows.length) { showAlert('import-alert', 'Could not parse CSV.', 'danger'); return; }
    const site = detectSite(Object.keys(rows[0]));
    if (!site) { showAlert('import-alert', 'Could not detect site - make sure this is a DK or FD export.', 'danger'); return; }

    let norm = site === 'FD' ? normalizeFD(rows) : normalizeDK(rows);
    if (!norm.length) { showAlert('import-alert', 'No MLB rows found in this file.', 'danger'); return; }

    // Tag site on each row
    norm.forEach(r => r._site = site);
    norm._site = site;

    const dateFrom = gv('import-date-from');
    const dateTo   = gv('import-date-to');

    if (dateFrom || dateTo) {
      norm = norm.filter(r => {
        if (!r.date) return false;
        if (dateFrom && r.date < dateFrom) return false;
        if (dateTo   && r.date > dateTo)   return false;
        return true;
      });
      // Re-tag after filter
      norm.forEach(r => r._site = site);
      if (!norm.length) {
        showAlert('import-alert', 'No rows found in that date range. Check the filter or clear it.', 'danger'); return;
      }
    } else if (norm.length > 50) {
      const go = confirm(`${norm.length} lineup rows found with no date filter - this looks like a full history export.\n\nUse the date range filter to narrow to a specific slate, or click OK to import all.`);
      if (!go) return;
    }

    renderPreview(norm, site);
  };
  reader.readAsText(file);
}

function resetImport() {
  pendingRows = [];
  g('import-step1').style.display = 'block';
  g('import-step2').style.display = 'none';
  g('csv-file').value = '';
}

// - Dashboard -
function renderDashboard() {
  const all      = entries;
  const invested = all.reduce((a, e) => a + (e.invested || 0), 0);
  const winnings = all.reduce((a, e) => a + (e.win || 0), 0);
  const pl       = +(winnings - invested).toFixed(2);
  const roi      = invested > 0 ? pl / invested : 0;

  const cash     = all.filter(e => e.cls === 'Cash');
  const cashWins = cash.filter(e => e.cashed === 'Y').length;
  const cashRate = cash.length > 0 ? cashWins / cash.length : null;

  g('kpi-grid').innerHTML = [
    ['Total lineups',  all.length,                   '',                        ''],
    ['Total invested', '$' + invested.toFixed(2),    '',                        ''],
    ['Total winnings', '$' + winnings.toFixed(2),    '',                        ''],
    ['Net P/L',        (pl >= 0 ? '+' : '-') + '$' + Math.abs(pl).toFixed(2),
                       pl >= 0 ? 'pos' : 'neg',      ''],
    ['Overall ROI',    (roi * 100).toFixed(1) + '%', roi >= 0 ? 'pos' : 'neg', ''],
    ['Cash win rate',
      cashRate !== null ? (cashRate * 100).toFixed(0) + '%' : '-',
      cashRate !== null ? (cashRate >= 0.52 ? 'pos' : 'neg') : '',
      cashRate !== null ? 'target -52%' : 'no cash lineups yet'],
  ].map(([label, val, cls, sub]) =>
    `<div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value ${cls}">${val}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`).join('');

  // - Breakdown tables -
  function bucket(keyFn) {
    const map = {};
    all.forEach(e => {
      const k = keyFn(e) || 'Unknown';
      if (!map[k]) map[k] = { n: 0, invested: 0, win: 0, cashes: 0 };
      map[k].n++;
      map[k].invested += e.invested || 0;
      map[k].win      += e.win      || 0;
      if (e.cashed === 'Y') map[k].cashes++;
    });
    return map;
  }

  function breakdownCard(title, map, order) {
    const keys = order ? order.filter(k => map[k]) : Object.keys(map).sort();
    if (!keys.length) return '';
    const rows = keys.map(k => {
      const d   = map[k];
      const pl  = +(d.win - d.invested).toFixed(2);
      const roi = d.invested > 0 ? (pl / d.invested * 100).toFixed(1) + '%' : '-';
      const wr  = d.n > 0 ? Math.round(d.cashes / d.n * 100) + '%' : '-';
      return `<tr>
        <td>${k}</td>
        <td style="text-align:right;color:var(--gray-500)">${d.n}</td>
        <td style="text-align:right;color:var(--gray-500)">$${d.invested.toFixed(2)}</td>
        <td style="text-align:right" class="${pl >= 0 ? 'pos' : 'neg'}">${pl >= 0 ? '+' : ''}$${Math.abs(pl).toFixed(2)}</td>
        <td style="text-align:right" class="${pl >= 0 ? 'pos' : 'neg'}">${roi}</td>
        <td style="text-align:right;color:var(--gray-500)">${wr}</td>
      </tr>`;
    }).join('');
    return `<div class="breakdown-card">
      <h3>${title}</h3>
      <table class="bd-table">
        <thead><tr><th></th><th>N</th><th>Invested</th><th>P/L</th><th>ROI</th><th>Win%</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  const clsMap  = bucket(e => e.cls);
  const siteMap = bucket(e => e.site);
  const typeMap = bucket(e => {
    // Group cash types, show GPP sub-types too
    return e.ctype || e.cls || 'Unknown';
  });

  // GPP vs Cash - show both overall metrics + cash-specific win rate target note
  const gppVsCash = breakdownCard('GPP vs Cash', clsMap, ['GPP', 'Cash']);
  const bySite    = breakdownCard('By site', siteMap, ['DK', 'FD']);
  const byType    = breakdownCard('By contest type', typeMap, ['GPP','Double Up','50/50','H2H','Multiplier','Cash - Other']);

  g('breakdown-grid').innerHTML = [gppVsCash, bySite, byType].filter(Boolean).join('') ||
    '<p style="font-size:13px;color:var(--gray-400);grid-column:1/-1;padding:1rem">Import results to see breakdowns.</p>';
}

// - History -
function renderHistory() {
  const sf = gv('hist-site'), cf = gv('hist-class'), rf = gv('hist-cashed');
  let data = [...entries];
  if (sf) data = data.filter(e => e.site   === sf);
  if (cf) data = data.filter(e => e.cls    === cf);
  if (rf) data = data.filter(e => e.cashed === rf);

  if (!data.length) {
    g('hist-table').innerHTML = '<div class="empty"><i class="ti ti-database-off"></i>No entries yet - import a results CSV to get started.</div>';
    return;
  }

  const rows = data.map(e => `<tr>
    <td>${e.date || '-'}</td>
    <td><span class="badge ${(e.site||'').toLowerCase()}">${e.site || '-'}</span></td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${e.contest}">${e.contest}</td>
    <td><span class="badge ${e.cls === 'Cash' ? 'cash' : 'gpp'}">${e.cls || '-'}</span></td>
    <td>$${(e.fee||0).toFixed(2)}</td>
    <td>${e.pts != null ? e.pts.toFixed(1) : '-'}</td>
    <td>${e.rank || '-'}</td>
    <td>${e.cashed || '-'}</td>
    <td class="${(e.pl||0) >= 0 ? 'pos' : 'neg'}">${(e.pl||0) >= 0 ? '+' : ''}$${Math.abs(e.pl||0).toFixed(2)}</td>
    <td><button class="btn danger" style="padding:4px 8px;font-size:11px" onclick="deleteEntry('${e.id}')"><i class="ti ti-trash"></i></button></td>
  </tr>`).join('');

  g('hist-table').innerHTML = `<table>
    <thead><tr>
      <th>Date</th><th>Site</th><th>Contest</th><th>Class</th>
      <th>Fee</th><th>Score</th><th>Rank</th><th>Cash</th><th>P/L</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function deleteEntry(id) {
  if (!confirm('Remove this entry?')) return;
  entries = entries.filter(e => String(e.id) !== String(id));
  persist(); renderAll();
}

// - Export CSV -
function exportCSV() {
  if (!entries.length) { alert('No entries to export.'); return; }
  const h = ['Date','Site','Contest','Class','Contest Type','Fee','Score','Rank','Field Size','Cashed','Winnings','P/L'];
  const rows = entries.map(e => [
    e.date, e.site, e.contest, e.cls, e.ctype, e.fee,
    e.pts, e.rank, e.field, e.cashed, e.win, e.pl,
  ].map(v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`));
  const csv = [h.join(','), ...rows.map(r => r.join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = `mlb_dfs_${todayISO()}.csv`;
  a.click();
}

function renderAll() { renderDashboard(); renderHistory(); }

// -
// CASH LINEUP BUILDER
// -

const luData = { sal: null, splash: null, stok: null };
let luPool = [];
let luLineup = [];

function handleLuFile(type, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    if (!rows.length) { showAlert('lineup-alert', `Could not parse ${type} file.`, 'danger'); return; }
    luData[type] = rows;
    const slot = g(`slot-${type}`);
    const status = g(`status-${type}`);
    slot.classList.add('uploaded');
    status.textContent = `- ${rows.length} rows loaded`;
    // Show settings card once all three uploaded
    if (luData.sal && luData.splash && luData.stok) {
      g('lu-settings-card').style.display = 'block';
      showAlert('lineup-alert', 'All files loaded - configure settings and build.', 'success');
      // Auto-detect if pitcher self-conflict likely
      autoDetectExclusions();
    }
  };
  reader.readAsText(file);
}

function autoDetectExclusions() {
  // Wire up blur validation on lock fields once pool is built
  ['lu-lock-sp1','lu-lock-sp2','lu-lock-h1','lu-lock-h2'].forEach(id => {
    const el = g(id); if (!el) return;
    el.oninput = () => validateLockField(el, id.includes('sp') ? 'SP' : null);
  });
}

function validateLockField(input, pos) {
  const val = input.value.trim();
  if (!val) { input.classList.remove('field-error'); return true; }
  if (!luPool.length) return true; // pool not built yet, skip
  // For hitters with slot override, just check name exists in pool
  const found = luPool.find(p =>
    p.name.toLowerCase().includes(val.toLowerCase()) && (!pos || p.pos.split('/').some(s => s.trim() === pos))
  );
  if (!found) {
    input.classList.add('field-error');
    // Show suggestions in title tooltip
    const words = val.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const pool = pos ? luPool.filter(p => p.pos.includes(pos)) : luPool;
    const suggestions = pool
      .map(p => ({ name: p.name, m: words.filter(w => p.name.toLowerCase().includes(w)).length }))
      .filter(x => x.m > 0).sort((a,b) => b.m - a.m).slice(0,3).map(x => x.name);
    input.title = suggestions.length ? 'Did you mean: ' + suggestions.join(', ') + '?' : 'No match found';
    return false;
  }
  input.classList.remove('field-error');
  input.title = '- ' + found.name;
  return true;
}

function parseLuSalaries(rows) {
  const out = {};
  rows.forEach(r => {
    const name = (r['name'] || r['Name'] || '').trim();
    const sal  = parseInt((r['salary'] || r['Salary'] || '0').replace(/[$,]/g,'')) || 0;
    const rawPos  = (r['position'] || r['Position'] || '').trim();
    const team = (r['teamabbrev'] || r['TeamAbbrev'] || r['team abbrev'] || r['Team Abbrev'] || '').trim();
    const id   = (r['id'] || r['ID'] || r['playerid'] || r['PlayerID'] || r['player id'] || '').trim();
    // Normalize: SP/RP both become SP for optimizer; keep multi-position as-is
    const pos = (rawPos === 'RP') ? 'SP' : rawPos;
    if (name && sal) out[name] = { sal, pos, team, id };
  });
  return out;
}

function parseLuSplash(rows) {
  const out = {};
  rows.forEach(r => {
    // "Player Name and Id", "Player Name", "Projection"
    const name = (r['player name'] || r['Player Name'] || r['name'] || '').trim();
    const proj = parseFloat(r['projection'] || r['Projection'] || r['fpts'] || 0) || 0;
    if (name) out[name] = proj;
  });
  return out;
}

function parseLuStok(rows) {
  const out = {};
  rows.forEach(r => {
    // Data Hub: Player, Team, Pos, Roster Pos, Fpts, Salary...
    const name = (r['player'] || r['Player'] || r['name'] || '').trim();
    const proj = parseFloat(r['fpts'] || r['Fpts'] || r['projection'] || r['Projection'] || 0) || 0;
    const team = (r['team'] || r['Team'] || '').trim();
    const pos  = (r['roster pos'] || r['Roster Pos'] || r['position'] || r['Position'] || '').trim();
    if (name) out[name] = { proj, team, pos };
  });
  return out;
}

function buildLineup() {
  if (!luData.sal || !luData.splash || !luData.stok) {
    showAlert('lineup-alert', 'Please upload all three files first.', 'info'); return;
  }

  const CAP       = parseInt(gv('lu-cap')) || 50000;
  const MAX_DIFF  = parseFloat(g('lu-max-diff').value) || 2.5;
  const excludeRaw = gv('lu-exclude-teams').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);

  // Parse all three sources first so we can validate locks
  const salMap    = parseLuSalaries(luData.sal);
  const splashMap = parseLuSplash(luData.splash);
  const stokMap   = parseLuStok(luData.stok);

  // Build consensus pool
  luPool = [];
  const allNames = new Set([...Object.keys(salMap), ...Object.keys(splashMap)]);

  allNames.forEach(name => {
    const salData  = salMap[name];
    if (!salData) return;
    const sp = splashMap[name] || 0;
    const stEntry = stokMap[name];
    const st = stEntry ? stEntry.proj : 0;
    const team = salData.team || (stEntry ? stEntry.team : '');
    const pos  = salData.pos  || (stEntry ? stEntry.pos  : '');
    if (sp === 0 || st === 0) return;
    if (salData.sal === 0) return;
    const diff      = Math.abs(sp - st);
    const consensus = (sp + st) / 2;
    luPool.push({ name, team, pos, sal: salData.sal, sp, st, diff, consensus });
  });

  // - Validate lock fields before proceeding -
  const h1Slot = gv('lu-lock-h1-pos') || null;
  const h2Slot = gv('lu-lock-h2-pos') || null;
  const lockFields = [
    { id: 'lu-lock-sp1', label: 'Lock SP1', pos: 'SP' },
    { id: 'lu-lock-sp2', label: 'Lock SP2', pos: 'SP' },
    { id: 'lu-lock-h1',  label: 'Lock hitter 1', pos: h1Slot },
    { id: 'lu-lock-h2',  label: 'Lock hitter 2', pos: h2Slot },
  ];

  const findPlayer = (nameInput, pos) => {
    if (!nameInput) return null;
    const nl = nameInput.trim().toLowerCase();
    return luPool.find(p => p.name.toLowerCase().includes(nl) && (!pos || p.pos.includes(pos)));
  };

  // Fuzzy suggestion: find closest name match by shared words
  const suggestPlayer = (nameInput, pos) => {
    const words = nameInput.trim().toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const candidates = pos ? luPool.filter(p => p.pos.includes(pos)) : luPool;
    const scored = candidates.map(p => {
      const pn = p.name.toLowerCase();
      const matches = words.filter(w => pn.includes(w)).length;
      return { name: p.name, matches };
    }).filter(x => x.matches > 0).sort((a,b) => b.matches - a.matches);
    return scored.slice(0,3).map(x => x.name);
  };

  let validationFailed = false;
  lockFields.forEach(f => {
    const input = g(f.id);
    const val = input ? input.value.trim() : '';
    if (!val) { input && input.classList.remove('field-error'); return; }
    const found = findPlayer(val, f.pos);
    if (!found) {
      input.classList.add('field-error');
      const suggestions = suggestPlayer(val, f.pos);
      const hint = suggestions.length
        ? ` Did you mean: ${suggestions.join(', ')}?`
        : ' No match found in today\'s slate.';
      showAlert('lineup-alert', `${f.label}: "${val}" not found.${hint}`, 'danger');
      validationFailed = true;
    } else {
      input.classList.remove('field-error');
    }
  });
  if (validationFailed) return;

  const locks = [
    gv('lu-lock-sp1'), gv('lu-lock-sp2'),
    gv('lu-lock-h1'),  gv('lu-lock-h2'),
  ].filter(Boolean).map(s => s.trim().toLowerCase());

  // Apply exclusions: user-specified teams
  const excludeTeams = new Set(excludeRaw);

  // Filter pool: no excluded teams, consensus diff within threshold
  const eligiblePool = luPool.filter(p => {
    if (excludeTeams.has(p.team.toUpperCase())) return false;
    return true;
  });

  // Separate consensus-only pool (diff <= MAX_DIFF) vs all eligible
  const consensusPool = eligiblePool.filter(p => p.diff <= MAX_DIFF);

  // Position pools — match on primary position only to avoid multi-pos confusion
  const posPool = (pos, useConsensus = true) => {
    const pool = useConsensus ? consensusPool : eligiblePool;
    return pool.filter(p => {
      if (!p.pos) return false;
      const primary = p.pos.split('/')[0].trim();
      return primary === pos;
    }).sort((a, b) => b.consensus - a.consensus);
  };

  // For hitter locks, use user-specified slot if provided — overrides player's primary pos
  const h1SlotOverride = gv('lu-lock-h1-pos');
  const h2SlotOverride = gv('lu-lock-h2-pos');

  const lockedSP1 = findPlayer(gv('lu-lock-sp1'), 'SP');
  const lockedSP2 = findPlayer(gv('lu-lock-sp2'), 'SP');
  const lockedH1  = findPlayer(gv('lu-lock-h1'));
  const lockedH2  = findPlayer(gv('lu-lock-h2'));

  // Tag each locked player with the slot they're filling
  if (lockedSP1) lockedSP1._slot = 'SP';
  if (lockedSP2) lockedSP2._slot = 'SP';
  if (lockedH1)  lockedH1._slot  = h1SlotOverride || lockedH1.pos.split('/')[0].trim();
  if (lockedH2)  lockedH2._slot  = h2SlotOverride || lockedH2.pos.split('/')[0].trim();

  const locked = [lockedSP1, lockedSP2, lockedH1, lockedH2].filter(Boolean);
  const lockedNames = new Set(locked.map(p => p.name));
  const lockedSal = locked.reduce((a, p) => a + p.sal, 0);
  const remaining = CAP - lockedSal;

  // Determine what slots still need to be filled using the assigned slot
  const filledPositions = { SP: 0, C: 0, '1B': 0, '2B': 0, '3B': 0, SS: 0, OF: 0 };
  locked.forEach(p => {
    const slot = p._slot || p.pos.split('/')[0].trim();
    if (slot === 'SP') filledPositions.SP++;
    else if (slot === 'C') filledPositions.C++;
    else if (slot === '1B') filledPositions['1B']++;
    else if (slot === '2B') filledPositions['2B']++;
    else if (slot === '3B') filledPositions['3B']++;
    else if (slot === 'SS') filledPositions.SS++;
    else if (slot === 'OF') filledPositions.OF++;
  });

  const slotsNeeded = {
    SP: 2 - filledPositions.SP,
    C:  1 - filledPositions.C,
    '1B': 1 - filledPositions['1B'],
    '2B': 1 - filledPositions['2B'],
    '3B': 1 - filledPositions['3B'],
    SS: 1 - filledPositions.SS,
    OF: 3 - filledPositions.OF,
  };

  // - Salary-aware optimizer -
  // For each needed slot, build a candidate list (consensus pool first, fallback to eligible)
  // Then use a branch-and-bound style search: try combinations keeping track of
  // remaining salary headroom per unfilled slot to avoid dead ends.
  const warnings = [];

  // Minimum salary needed per remaining slot (use cheapest available at each pos)
  function minCostPerPos(pos, usedNames) {
    const pool = [...consensusPool, ...eligiblePool].filter(p =>
      p.pos && p.pos.split('/')[0].trim() === pos && !usedNames.has(p.name)
    );
    if (!pool.length) return 0;
    return Math.min(...pool.map(p => p.sal));
  }

  // Candidates for each needed slot, consensus first then fallback
  function getCandidates(pos, usedNames, budgetRemaining) {
    const primaryMatch = p => p.pos && p.pos.split('/')[0].trim() === pos;
    const consensus = consensusPool.filter(p =>
      primaryMatch(p) && !usedNames.has(p.name) && p.sal <= budgetRemaining
    ).sort((a,b) => b.consensus - a.consensus);
    if (consensus.length) return consensus;
    return eligiblePool.filter(p =>
      primaryMatch(p) && !usedNames.has(p.name) && p.sal <= budgetRemaining
    ).sort((a,b) => b.consensus - a.consensus);
  }

  // Slots to fill in order (fill expensive/constrained positions first)
  const slotsToFill = [];
  Object.entries(slotsNeeded).forEach(([pos, count]) => {
    for (let i = 0; i < count; i++) slotsToFill.push(pos);
  });
  // Sort: fill most constrained positions first (fewest options)
  slotsToFill.sort((a, b) => {
    const aOpts = getCandidates(a, lockedNames, remaining).length;
    const bOpts = getCandidates(b, lockedNames, remaining).length;
    return aOpts - bOpts;
  });

  // ── Greedy optimizer with salary headroom check ──────────────────────────
  // Fill slots in order (most constrained first).
  // At each step: pick highest-consensus player where salary leaves enough
  // for all remaining slots at their minimum cost.
  // To avoid local optima, run N_PASSES greedy passes with slight variation
  // and keep the best result.

  function greedyPass(slotsArr, startPool, budget) {
    const chosen = [];
    const used = new Set(lockedNames);
    let left = budget;

    for (const pos of slotsArr) {
      // Min cost needed for slots after this one
      const remaining = slotsArr.slice(slotsArr.indexOf(pos) + 1 + chosen.length - chosen.length);
      // simpler: track index manually
      const idx = chosen.length;
      const restSlots = slotsArr.slice(idx + 1);
      const minRest = restSlots.reduce((sum, rpos) => {
        const opts = startPool.filter(p =>
          p.pos.split('/')[0].trim() === rpos && !used.has(p.name)
        );
        return sum + (opts.length ? Math.min(...opts.map(p=>p.sal)) : 0);
      }, 0);

      const budget_for_this = left - minRest;
      const candidates = startPool.filter(p =>
        p.pos.split('/')[0].trim() === pos &&
        !used.has(p.name) &&
        p.sal <= budget_for_this
      ).sort((a,b) => b.consensus - a.consensus);

      if (!candidates.length) return null; // dead end
      const pick = candidates[0];
      // Tag with the slot actually being filled (handles multi-pos players)
      const tagged = Object.assign(Object.create(Object.getPrototypeOf(pick)), pick, { _slot: pos });
      chosen.push(tagged);
      used.add(pick.name);
      left -= pick.sal;
    }
    return chosen;
  }

  // Sort slots: most constrained (fewest candidates) first
  const sortedSlots = [...slotsToFill].sort((a, b) => {
    const aOpts = getCandidates(a, lockedNames, remaining).length;
    const bOpts = getCandidates(b, lockedNames, remaining).length;
    return aOpts - bOpts;
  });

  // Try consensus pool first, then eligible, then full pool
  const poolsToTry = [consensusPool, eligiblePool, luPool.filter(p => !excludeTeams.has(p.team.toUpperCase()))];
  let bestCombo = null;
  let bestTotal = -1;

  for (const tryPool of poolsToTry) {
    if (bestCombo) break;
    // Try a few slot orderings to avoid local optima
    const orderings = [sortedSlots, [...sortedSlots].reverse(), slotsToFill];
    for (const ordering of orderings) {
      const result = greedyPass(ordering, tryPool, remaining);
      if (result) {
        const total = result.reduce((a,p) => a + p.consensus, 0);
        if (total > bestTotal) { bestTotal = total; bestCombo = result; }
      }
    }
    if (!bestCombo && tryPool === consensusPool) {
      warnings.push('No consensus lineup found within budget - relaxing disagreement threshold.');
    }
  }

  if (!bestCombo) {
    showAlert('lineup-alert', 'Could not build a valid lineup - check salary cap, excluded teams, or locked players.', 'danger');
    return;
  }

  // Flag any players outside consensus threshold
  bestCombo.forEach(p => {
    if (p.diff > MAX_DIFF) warnings.push(`${p.name} is outside consensus threshold (diff: ${p.diff.toFixed(1)} pts) - no better option was available.`);
  });

  luLineup = [...locked, ...bestCombo];

  // Safety net: count slots and warn if wrong
  const REQUIRED = { SP: 2, C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 3 };
  const actualSlots = { SP: 0, C: 0, '1B': 0, '2B': 0, '3B': 0, SS: 0, OF: 0 };
  luLineup.forEach(p => {
    const slot = p._slot || p.pos.split('/')[0].trim();
    if (actualSlots[slot] !== undefined) actualSlots[slot]++;
  });
  Object.entries(REQUIRED).forEach(([pos, req]) => {
    if (actualSlots[pos] !== req)
      warnings.push(`Slot count issue: ${pos} needs ${req}, got ${actualSlots[pos]}. Set the Slot dropdown for your locked hitters to fix this.`);
  });

  // Sort display order — use _slot if set to avoid multi-pos sort confusion
  const posOrder = { SP: 0, C: 1, '1B': 2, '2B': 3, '3B': 4, SS: 5, OF: 6 };
  luLineup.sort((a, b) => {
    const sa = a._slot || a.pos.split('/')[0].trim();
    const sb = b._slot || b.pos.split('/')[0].trim();
    return (posOrder[sa] ?? 9) - (posOrder[sb] ?? 9);
  });

  renderLineupResult(warnings, CAP, MAX_DIFF);
  g('lu-result').style.display = 'block';
  renderPool();
}

function renderLineupResult(warnings, CAP, MAX_DIFF) {
  const totalSal  = luLineup.reduce((a, p) => a + p.sal, 0);
  const totalSP   = luLineup.reduce((a, p) => a + p.sp, 0);
  const totalST   = luLineup.reduce((a, p) => a + p.st, 0);
  const totalCons = luLineup.reduce((a, p) => a + p.consensus, 0);
  const under = CAP - totalSal;

  const posLabel = p => {
    if (p.pos.includes('SP')) return 'P';
    if (p.pos.includes('OF')) return 'OF';
    if (p.pos.includes('SS')) return 'SS';
    if (p.pos.includes('3B')) return '3B';
    if (p.pos.includes('2B')) return '2B';
    if (p.pos.includes('1B')) return '1B';
    if (p.pos.includes('C'))  return 'C';
    return p.pos;
  };

  const rows = luLineup.map(p => {
    const diffFlag = p.diff > MAX_DIFF
      ? `<span style="color:var(--red);font-size:10px"> - diff ${p.diff.toFixed(1)}</span>` : '';
    return `<tr>
      <td><strong>${posLabel(p)}</strong></td>
      <td>${p.name}${diffFlag}</td>
      <td>${p.team}</td>
      <td style="text-align:right">$${p.sal.toLocaleString()}</td>
      <td style="text-align:right">${p.sp.toFixed(2)}</td>
      <td style="text-align:right">${p.st.toFixed(2)}</td>
      <td style="text-align:right"><strong>${p.consensus.toFixed(2)}</strong></td>
      <td style="text-align:right;color:var(--gray-500)">${p.diff.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const capColor = under >= 0 ? 'var(--green)' : 'var(--red)';
  const capLabel = under >= 0 ? `$${under.toLocaleString()} under cap` : `$${Math.abs(under).toLocaleString()} OVER CAP`;

  g('lu-lineup-table').innerHTML = `
    <table class="bd-table" style="font-size:13px">
      <thead><tr>
        <th style="text-align:left">Pos</th>
        <th style="text-align:left">Player</th>
        <th style="text-align:left">Team</th>
        <th>Salary</th>
        <th>SplashPlay</th>
        <th>Stokastic</th>
        <th>Consensus</th>
        <th>Diff</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="font-weight:600;border-top:2px solid var(--gray-200)">
          <td colspan="3">TOTAL</td>
          <td style="text-align:right">$${totalSal.toLocaleString()}</td>
          <td style="text-align:right">${totalSP.toFixed(2)}</td>
          <td style="text-align:right">${totalST.toFixed(2)}</td>
          <td style="text-align:right">${totalCons.toFixed(2)}</td>
          <td></td>
        </tr>
        <tr>
          <td colspan="8" style="text-align:right;font-size:12px;color:${capColor};font-weight:600">${capLabel}</td>
        </tr>
      </tfoot>
    </table>`;

  const warnHTML = warnings.length
    ? warnings.map(w => `<div class="alert info" style="margin-bottom:6px"><i class="ti ti-alert-circle"></i>${w}</div>`).join('')
    : '<div style="font-size:12px;color:var(--gray-500)">No warnings - all players within consensus threshold.</div>';
  g('lu-warnings').innerHTML = warnHTML;

  // Show export button
  const existingBtn = g('lu-export-btn');
  if (existingBtn) existingBtn.remove();
  const btn = document.createElement('button');
  btn.id = 'lu-export-btn';
  btn.className = 'btn primary';
  btn.style.marginTop = '1rem';
  btn.innerHTML = '<i class="ti ti-download"></i> Export for DK upload';
  btn.onclick = exportLineupDK;
  g('lu-lineup-table').after(btn);
}

function renderPool() {
  if (!luPool.length) return;
  const posFilter  = gv('lu-pool-pos');
  const sortBy     = gv('lu-pool-sort') || 'consensus';
  const MAX_DIFF   = parseFloat(g('lu-max-diff').value) || 2.5;
  const excludeRaw = gv('lu-exclude-teams').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
  const excludeTeams = new Set(excludeRaw);

  let data = [...luPool].filter(p => !excludeTeams.has(p.team.toUpperCase()));
  if (posFilter) data = data.filter(p => p.pos && p.pos.includes(posFilter));
  data.sort((a, b) => {
    if (sortBy === 'diff')    return a.diff - b.diff;
    if (sortBy === 'salary')  return b.sal - a.sal;
    return b.consensus - a.consensus;
  });

  const inLineup = new Set(luLineup.map(p => p.name));

  const rows = data.slice(0, 60).map(p => {
    const highlight = inLineup.has(p.name) ? 'background:var(--green-light)' : '';
    const flagStyle = p.diff > MAX_DIFF ? 'color:var(--red)' : 'color:var(--green)';
    return `<tr style="${highlight}">
      <td>${p.pos}</td>
      <td>${p.name}${inLineup.has(p.name) ? ' <span style="font-size:10px;color:var(--green);font-weight:600">- IN</span>' : ''}</td>
      <td>${p.team}</td>
      <td style="text-align:right">$${p.sal.toLocaleString()}</td>
      <td style="text-align:right">${p.sp.toFixed(2)}</td>
      <td style="text-align:right">${p.st.toFixed(2)}</td>
      <td style="text-align:right"><strong>${p.consensus.toFixed(2)}</strong></td>
      <td style="text-align:right;${flagStyle}">${p.diff.toFixed(2)}</td>
    </tr>`;
  }).join('');

  g('lu-pool-table').innerHTML = `<table>
    <thead><tr>
      <th>Pos</th><th>Player</th><th>Team</th><th>Salary</th>
      <th>SplashPlay</th><th>Stokastic</th><th>Consensus</th><th>Diff</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function exportLineupDK() {
  if (!luLineup.length) return;
  const salMap = parseLuSalaries(luData.sal);

  // DK slot order: P, P, C, 1B, 2B, 3B, SS, OF, OF, OF
  const slotOrder = ['SP','SP','C','1B','2B','3B','SS','OF','OF','OF'];
  const sorted = [...luLineup];
  const posOrder = { SP:0, C:1, '1B':2, '2B':3, '3B':4, SS:5, OF:6 };
  sorted.sort((a,b) => {
    const pa = ['SP','C','1B','2B','3B','SS','OF'].find(k => a.pos.includes(k));
    const pb = ['SP','C','1B','2B','3B','SS','OF'].find(k => b.pos.includes(k));
    return (posOrder[pa]||9) - (posOrder[pb]||9);
  });

  const header = 'P,P,C,1B,2B,3B,SS,OF,OF,OF';
  const cells = sorted.map(p => {
    const salEntry = salMap[p.name];
    const id = salEntry ? salEntry.id : '';
    return id ? `${p.name} (${id})` : p.name;
  });
  const csv = header + '\n' + cells.join(',') + ',';

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = `DK_cash_lineup_${todayISO()}.csv`;
  a.click();
}

function resetLineupBuilder() {
  luData.sal = luData.splash = luData.stok = null;
  luPool = []; luLineup = [];
  ['sal','splash','stok'].forEach(t => {
    const slot = g(`slot-${t}`); if(slot) slot.classList.remove('uploaded');
    const status = g(`status-${t}`); if(status) status.textContent = 'Not uploaded';
    const file = g(`file-${t}`); if(file) file.value = '';
  });
  g('lu-settings-card').style.display = 'none';
  g('lu-result').style.display = 'none';
  ['lu-lock-sp1','lu-lock-sp2','lu-lock-h1','lu-lock-h2','lu-exclude-teams'].forEach(id => {
    const el = g(id); if(el) el.value = '';
  });
}
