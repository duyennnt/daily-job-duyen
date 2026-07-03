// Nightly full-universe screener — runs in GitHub Actions (Node 20+, no dependencies).
// Env: FINNHUB_KEY (required, repo secret), GEMINI_KEY (optional, repo secret),
//      CAP_MIN_M / CAP_MAX_M (optional, $ millions, default 300–10000),
//      PEG_MAX / G_MIN / G_MAX / DTE_MAX (optional Lynch thresholds).
// Output: screen-results.json at repo root (the dashboard loads it).

const FIN = process.env.FINNHUB_KEY;
if (!FIN) { console.error('FINNHUB_KEY secret is not set'); process.exit(1); }
const GEM = process.env.GEMINI_KEY || '';
const CAP_MIN = Number(process.env.CAP_MIN_M || 300);      // $M
const CAP_MAX = Number(process.env.CAP_MAX_M || 10000);    // $M
const CRIT = {
  peg_max: Number(process.env.PEG_MAX || 1.0),
  g_min:   Number(process.env.G_MIN   || 20),
  g_max:   Number(process.env.G_MAX   || 50),
  dte_max: Number(process.env.DTE_MAX || 0.33),
};
const THROTTLE_MS = 1100; // ~55 calls/min, inside Finnhub free tier

const sleep = ms => new Promise(r => setTimeout(r, ms));
const numOr = v => { const n = Number(v); return isNaN(n) || !isFinite(n) ? null : n; };

async function fin(path, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    const r = await fetch(`https://finnhub.io/api/v1/${path}${path.includes('?') ? '&' : '?'}token=${FIN}`);
    if (r.status === 429) { console.log('  429 — waiting 35s'); await sleep(35000); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

function extract(m) {
  if (!m) return null;
  const pick = (...ks) => { for (const k of ks) { const v = numOr(m[k]); if (v !== null) return v; } return null; };
  return {
    pe:  pick('peTTM', 'peBasicExclExtraTTM', 'peNormalizedAnnual'),
    g:   pick('epsGrowth5Y', 'epsGrowth3Y', 'epsGrowthTTMYoy'),
    dy:  pick('currentDividendYieldTTM', 'dividendYieldIndicatedAnnual') || 0,
    dte: pick('totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual'),
    mc:  pick('marketCapitalization'),
    roc: pick('roiTTM', 'roiAnnual', 'roeTTM'),
    npm: pick('netProfitMarginTTM', 'netProfitMarginAnnual'),
    opm: pick('operatingMarginTTM', 'operatingMarginAnnual'),
  };
}

function qualityCheck(x, minMargin) {
  const flags = []; let fail = false;
  if (!x) return { fail: true, flags: ['no data'] };
  if (x.npm !== null && x.npm > 100) { fail = true; flags.push('net margin >100% (non-operating gains)'); }
  if (x.npm !== null && x.npm >= 0 && x.npm < minMargin) flags.push(`thin net margin ${x.npm.toFixed(1)}%`);
  if (x.roc !== null && x.opm !== null && x.opm > 0 && x.roc > 60 && x.roc > x.opm * 4) flags.push('return far exceeds operating margin (one-time gains)');
  return { fail, flags };
}

function judgeLynch(x) {
  if (!x || x.pe === null || x.pe <= 0 || x.g === null) return { pass: false, fails: ['no earnings/growth data'] };
  const fails = [];
  const peg = x.pe / (x.g + x.dy);
  if (!(peg > 0 && peg < CRIT.peg_max)) fails.push(`PEG ${peg > 0 ? peg.toFixed(2) : 'n/a'} >= ${CRIT.peg_max}`);
  if (x.g < CRIT.g_min) fails.push(`growth ${x.g.toFixed(0)}% < ${CRIT.g_min}%`);
  if (x.g > CRIT.g_max) fails.push(`growth ${x.g.toFixed(0)}% > ${CRIT.g_max}% (hypergrowth)`);
  if (x.dte === null) fails.push('no debt data');
  else if (x.dte >= CRIT.dte_max) fails.push(`D/E ${x.dte.toFixed(2)} >= ${CRIT.dte_max}`);
  return { pass: fails.length === 0, peg, fails };
}

async function geminiStory(t, name, x) {
  if (!GEM) return null;
  const facts = [
    `${t} (${name || ''})`,
    x.pe !== null ? `P/E ${x.pe.toFixed(1)}x` : null,
    x.g !== null ? `EPS growth ~${x.g.toFixed(0)}%/yr` : null,
    x.dte !== null ? `debt/equity ${x.dte.toFixed(2)}` : null,
    x.dy ? `dividend yield ${x.dy.toFixed(1)}%` : null,
    x.mc ? `market cap $${x.mc >= 1000 ? (x.mc / 1000).toFixed(1) + 'B' : x.mc.toFixed(0) + 'M'}` : null,
  ].filter(Boolean).join('\n');
  const prompt = 'You are an equity analyst. In 2 tight sentences: sentence 1 MUST answer why this stock is interesting right now (the bet); sentence 2 the main risk. No hedging, no advice, no preamble. Facts:\n' + facts;
  for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEM}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 160 } }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (txt && txt.length > 30) return txt.slice(0, 400);
    } catch (e) {}
    await sleep(1200);
  }
  return null;
}

async function main() {
  console.log('Loading full US universe…');
  const sy = await fin('stock/symbol?exchange=US');
  if (!Array.isArray(sy) || !sy.length) { console.error('Universe fetch failed'); process.exit(1); }
  const pool = sy
    .filter(s => (s.type === 'Common Stock' || !s.type) && /^[A-Z]{1,5}$/.test(s.symbol || ''))
    .map(s => s.symbol).sort();
  console.log(`Universe: ${pool.length} symbols; cap band $${CAP_MIN}M–$${CAP_MAX}M`);

  const qual = [], misses = [], cands = [];
  let checked = 0;
  for (const t of pool) {
    checked++;
    if (checked % 200 === 0) console.log(`  ${checked}/${pool.length} … ${qual.length} qualified, ${cands.length} magic candidates`);
    const j = await fin(`stock/metric?symbol=${t}&metric=all`);
    await sleep(THROTTLE_MS);
    const x = extract(j && j.metric);
    if (!x || x.mc === null || x.mc < CAP_MIN || x.mc > CAP_MAX) continue;
    const MIN_MARGIN = Number(process.env.MIN_MARGIN || 5);
    const qc = qualityCheck(x, MIN_MARGIN);
    if (qc.fail) continue; // mirage — skip entirely
    // Lynch
    const v = judgeLynch(x);
    if (v.pass) qual.push({ t, x, peg: v.peg, flags: qc.flags });
    else if (v.fails.length === 1 && x.pe > 0) misses.push({ t, x, j: { fails: v.fails } });
    // Magic candidates
    if (x.pe !== null && x.pe > 0 && x.roc !== null) cands.push({ t, x, flags: qc.flags });
  }
  qual.sort((a, b) => a.peg - b.peg);

  // Magic Formula ranking
  const byEy  = [...cands].sort((a, b) => (100 / a.x.pe) < (100 / b.x.pe) ? 1 : -1);
  const byRoc = [...cands].sort((a, b) => a.x.roc < b.x.roc ? 1 : -1);
  const rk = {};
  byEy.forEach((c, i) => rk[c.t] = (rk[c.t] || 0) + i);
  byRoc.forEach((c, i) => rk[c.t] = (rk[c.t] || 0) + i);
  const magicTop = [...cands].sort((a, b) => rk[a.t] - rk[b.t]).slice(0, 25);

  // Names for the winners only
  const nameOf = {};
  for (const c of [...qual.slice(0, 40), ...magicTop]) {
    if (nameOf[c.t]) continue;
    const p = await fin(`stock/profile2?symbol=${c.t}`);
    await sleep(THROTTLE_MS);
    nameOf[c.t] = (p && p.name) || '';
  }
  qual.forEach(q => q.name = nameOf[q.t] || '');
  magicTop.forEach(q => q.name = nameOf[q.t] || '');

  // Optional AI stories for top Lynch qualifiers
  if (GEM) {
    console.log('Generating AI stories for top qualifiers…');
    for (const q of qual.slice(0, 10)) q.story = await geminiStory(q.t, q.name, q.x);
  }

  const out = {
    ts: Date.now(),
    generated: new Date().toISOString(),
    universe: pool.length,
    capBandM: [CAP_MIN, CAP_MAX],
    criteria: CRIT,
    lynch: { qual: qual.slice(0, 40), misses: misses.slice(0, 25) },
    magic: { top: magicTop },
  };
  const fs = await import('fs');
  fs.writeFileSync('screen-results.json', JSON.stringify(out));

  // ---- Email digest (email-body.html; sent by the workflow if mail secrets exist) ----
  const site = process.env.SITE_URL || '';
  const capTxt = m => m >= 1000 ? '$' + (m / 1000).toFixed(1) + 'B' : '$' + m.toFixed(0) + 'M';
  const row = q => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${q.t}</b><br><span style="color:#888;font-size:12px">${q.name || ''}</span></td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#0a7d4f"><b>${q.peg.toFixed(2)}</b></td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${q.x.pe.toFixed(1)}×</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${q.x.g.toFixed(0)}%</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${q.x.dte !== null ? q.x.dte.toFixed(2) : '—'}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${q.x.mc ? capTxt(q.x.mc) : '—'}</td></tr>`
    + (q.flags && q.flags.length ? `<tr><td colspan="6" style="padding:0 10px 8px;border-bottom:1px solid #eee;color:#b8860b;font-size:12px">⚠ ${q.flags.join(' · ')}</td></tr>` : '')
    + (q.story ? `<tr><td colspan="6" style="padding:2px 10px 10px;border-bottom:1px solid #eee;color:#555;font-size:13px">${q.story}</td></tr>` : '');
  const mrow = (c, i) => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">#${i + 1} <b>${c.t}</b> <span style="color:#888;font-size:12px">${c.name || ''}</span></td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#0a7d4f">${(100 / c.x.pe).toFixed(1)}%</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#0a7d4f">${c.x.roc.toFixed(1)}%</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${c.x.pe.toFixed(1)}×</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${c.x.mc ? capTxt(c.x.mc) : '—'}</td></tr>`;
  const th = t => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-size:12px;color:#666">${t}</th>`;
  const email = `<div style="font-family:Georgia,serif;max-width:680px;margin:auto;color:#222">
  <h2 style="margin:14px 0 2px">Nightly screen digest</h2>
  <p style="color:#666;margin:0 0 14px">${new Date().toUTCString()} · ${pool.length} US names scanned · cap band ${capTxt(CAP_MIN)}–${capTxt(CAP_MAX)} · PEG&lt;${CRIT.peg_max}, growth ${CRIT.g_min}–${CRIT.g_max}%, D/E&lt;${CRIT.dte_max}</p>
  <h3 style="margin:16px 0 6px">Lynch qualifiers — ${qual.length}</h3>
  ${qual.length ? `<table style="border-collapse:collapse;width:100%"><tr>${th('Ticker')}${th('PEG')}${th('P/E')}${th('Growth')}${th('D/E')}${th('Cap')}</tr>${qual.slice(0, 15).map(row).join('')}</table>` : '<p style="color:#666">None passed the full screen tonight — strict criteria, honest result.</p>'}
  <h3 style="margin:20px 0 6px">Magic Formula — top 10</h3>
  ${magicTop.length ? `<table style="border-collapse:collapse;width:100%"><tr>${th('Rank / Ticker')}${th('Earn. yield')}${th('Ret. on cap')}${th('P/E')}${th('Cap')}</tr>${magicTop.slice(0, 10).map(mrow).join('')}</table>` : '<p style="color:#666">No candidates ranked.</p>'}
  ${site ? `<p style="margin-top:18px"><a href="${site}" style="color:#0a7d4f">Open the dashboard →</a></p>` : ''}
  <p style="color:#999;font-size:11px;margin-top:18px">Automated screen output — data snapshots, not investment advice. Stories are AI drafts from limited data.</p>
  </div>`;
  fs.writeFileSync('email-body.html', email);
  console.log(`Done: ${qual.length} Lynch qualifiers, ${misses.length} near-misses, ${cands.length} magic-ranked. Wrote screen-results.json + email-body.html`);
}

main().catch(e => { console.error(e); process.exit(1); });
