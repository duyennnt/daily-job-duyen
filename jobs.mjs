// Daily job-search digest — runs in GitHub Actions (Node 20+, no dependencies).
// Sources: Greenhouse / Lever / Ashby public boards (companies listed in job-config.json),
//          Remotive + RemoteOK free APIs for remote roles.
// Env: GEMINI_KEY (optional, adds one-line "why it fits" on top matches).
// Reads job-config.json (criteria) and seen-jobs.json (dedupe memory).
// Writes jobs-results.json, updates seen-jobs.json, and writes jobs-email.html
// ONLY when there are new matches (or emailWhenEmpty is true) — the workflow
// uses that file's existence to decide whether to send mail.

import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync('job-config.json', 'utf8'));
const GEM = process.env.GEMINI_KEY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = Date.now();
const maxAge = (cfg.maxAgeDays || 3) * 24 * 3600e3;

let seen = {};
try { seen = JSON.parse(fs.readFileSync('seen-jobs.json', 'utf8')); } catch (e) {}

const kw = (cfg.keywords || []).map(s => s.toLowerCase());
const ex = (cfg.excludeKeywords || []).map(s => s.toLowerCase());
const locs = (cfg.locations || []).map(s => s.toLowerCase());

function matches(job) {
  const t = (job.title || '').toLowerCase();
  if (kw.length && !kw.some(k => t.includes(k))) return false;
  if (ex.some(k => t.includes(k))) return false;
  const l = (job.location || '').toLowerCase();
  const isRemote = job.remote || l.includes('remote');
  if (cfg.remoteOnly && !isRemote) return false;
  const bypass = cfg.remoteBypassesLocation !== false; // default true (back-compat)
  if (locs.length && !(bypass && isRemote) && !locs.some(x => l.includes(x))) return false;
  if (cfg.requireDate && !job.date) return false;
  if (job.date && (now - job.date) > maxAge) return false;
  return true;
}

const strip = h => (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
function sponsorSignal(desc) {
  const d = strip(desc).toLowerCase();
  if (!d) return null;
  if (/(not|unable|cannot|can't|no)[^.]{0,50}sponsor/.test(d) || /no visa/.test(d)) return 'no';
  if (/visa sponsorship|sponsorship (is )?(available|offered|provided)|we sponsor|work (visa|permit)|relocation (assistance|support|package|budget)/.test(d)) return 'yes';
  if (/sponsor/.test(d)) return 'maybe';
  return null;
}

async function getJSON(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'job-digest-bot', ...headers } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

async function main() {
  const jobs = [];
  const push = j => { if (j.title && j.url) jobs.push(j); };

  // Greenhouse boards
  for (const c of cfg.greenhouseCompanies || []) {
    const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${c}/jobs?content=true`);
    (j?.jobs || []).forEach(x => push({
      id: 'gh:' + x.id, title: x.title, company: c,
      location: x.location?.name || '', url: x.absolute_url, desc: x.content || '',
      date: x.updated_at ? Date.parse(x.updated_at) : null, source: 'Greenhouse',
    }));
    await sleep(400);
  }
  // Lever boards
  for (const c of cfg.leverCompanies || []) {
    const j = await getJSON(`https://api.lever.co/v0/postings/${c}?mode=json`);
    (Array.isArray(j) ? j : []).forEach(x => push({
      id: 'lv:' + x.id, title: x.text, company: c,
      location: x.categories?.location || '', url: x.hostedUrl, desc: x.descriptionPlain || x.description || '',
      date: x.createdAt || null, source: 'Lever',
    }));
    await sleep(400);
  }
  // Ashby boards
  for (const c of cfg.ashbyCompanies || []) {
    const j = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${c}`);
    (j?.jobs || []).forEach(x => push({
      id: 'as:' + (x.id || x.jobUrl || x.title + c), title: x.title, company: c,
      location: x.location || '', remote: !!x.isRemote,
      url: x.jobUrl || x.applyUrl || '', desc: x.descriptionHtml || x.descriptionPlain || '', date: x.publishedAt ? Date.parse(x.publishedAt) : null, source: 'Ashby',
    }));
    await sleep(400);
  }
  // Remotive (remote roles, searched per keyword)
  for (const k of kw.slice(0, 4)) {
    const j = await getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(k)}&limit=50`);
    (j?.jobs || []).forEach(x => push({
      id: 'rv:' + x.id, title: x.title, company: x.company_name,
      location: x.candidate_required_location || 'Remote', remote: true,
      url: x.url, desc: x.description || '', date: x.publication_date ? Date.parse(x.publication_date) : null, source: 'Remotive',
    }));
    await sleep(600);
  }
  // RemoteOK (first array element is metadata)
  const ro = await getJSON('https://remoteok.com/api');
  (Array.isArray(ro) ? ro.slice(1) : []).forEach(x => push({
    id: 'ro:' + x.id, title: x.position || x.title || '', company: x.company || '',
    location: x.location || 'Remote', remote: true,
    url: x.url, desc: x.description || '', date: x.date ? Date.parse(x.date) : null, source: 'RemoteOK',
  }));

  // Filter → dedupe against seen
  const matched = jobs.filter(matches);
  const fresh = [];
  const dedup = new Set();
  for (const j of matched) {
    if (seen[j.id] || dedup.has(j.id)) continue;
    dedup.add(j.id); fresh.push(j);
  }
  let pool2 = fresh;
  if (cfg.sponsorshipSignals) {
    pool2.forEach(j => j.visa = sponsorSignal(j.desc));
    if (cfg.dropNoSponsor) pool2 = pool2.filter(j => j.visa !== 'no');
    pool2.sort((a, b) => ((b.visa === 'yes') - (a.visa === 'yes')) || ((b.date || 0) - (a.date || 0)));
  } else pool2.sort((a, b) => (b.date || 0) - (a.date || 0));
  pool2.forEach(j => delete j.desc); // keep results JSON small
  const digest = pool2.slice(0, cfg.maxPerDigest || 30);

  // Optional: one-line AI fit note on top matches
  if (GEM && digest.length) {
    for (const j of digest.slice(0, 10)) {
      try {
        const prompt = `Candidate profile: ${cfg.profile || cfg.keywords.join(', ')}. In ONE sentence, why might this posting fit them (or note the stretch)? Posting: "${j.title}" at ${j.company}, location: ${j.location}. Be specific, no fluff.`;
        for (const model of ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash-001', 'gemini-2.5-flash-lite']) {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEM}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 80 } }),
          });
          if (!r.ok) continue;
          const jr = await r.json();
          const txt = jr?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
          if (txt) { j.fit = txt.slice(0, 220); break; }
        }
        await sleep(1200);
      } catch (e) {}
    }
  }

  // Update seen memory (record everything matched, cap total size)
  matched.forEach(j => seen[j.id] = now);
  const entries = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 8000);
  fs.writeFileSync('seen-jobs.json', JSON.stringify(Object.fromEntries(entries)));
  fs.writeFileSync('jobs-results.json', JSON.stringify({ ts: now, newCount: digest.length, jobs: digest }));

  // Email body — only when there is something to say
  if (digest.length || cfg.emailWhenEmpty) {
    const ageTxt = d => !d ? '' : Math.max(0, Math.round((now - d) / 3600e3 / 24 * 10) / 10) + 'd ago';
    const row = j => `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">
        <a href="${j.url}" style="color:#0a5dbb;font-weight:bold;text-decoration:none">${j.title}</a><br>
        <span style="color:#444">${j.company}</span> · <span style="color:#888">${j.location || '—'}</span>
        <span style="color:#bbb;font-size:11px"> · ${j.source}${j.date ? ' · ' + ageTxt(j.date) : ''}</span>${j.visa === 'yes' ? ' <span style="color:#0a7d4f;font-size:11px;font-weight:bold">✓ mentions sponsorship</span>' : j.visa === 'maybe' ? ' <span style="color:#b8860b;font-size:11px">~ sponsor mentioned</span>' : ''}
        ${j.fit ? `<div style="color:#555;font-size:12.5px;margin-top:3px">${j.fit}</div>` : ''}
      </td></tr>`;
    const email = `<div style="font-family:Georgia,serif;max-width:660px;margin:auto;color:#222">
    <h2 style="margin:14px 0 2px">New job matches — ${digest.length}</h2>
    <p style="color:#666;margin:0 0 12px">${new Date().toUTCString()} · keywords: ${cfg.keywords.join(', ')} · ${cfg.remoteOnly ? 'remote only' : (cfg.locations.join(', ') || 'any location')}</p>
    ${digest.length ? `<table style="border-collapse:collapse;width:100%">${digest.map(row).join('')}</table>` : '<p style="color:#666">No new matches today.</p>'}
    <p style="color:#999;font-size:11px;margin-top:16px">Sources: Greenhouse/Lever/Ashby boards you listed + Remotive + RemoteOK. Edit job-config.json in the repo to change criteria.</p>
    </div>`;
    fs.writeFileSync('jobs-email.html', email);

    const RESEND = process.env.RESEND_KEY, MAIL_TO = process.env.MAIL_TO, MAIL_FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';
    if (RESEND && MAIL_TO) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Job Digest <' + MAIL_FROM + '>', to: [MAIL_TO], subject: `New job matches — ${digest.length}`, html: email }),
        });
        console.log('Email send status:', r.status);
        if (!r.ok) console.log('Email error:', await r.text());
      } catch (e) { console.log('Email exception:', e.message); }
    }
  }
  console.log(`Scanned ${jobs.length} postings → ${matched.length} matched criteria → ${digest.length} NEW in digest.`);
}

main().catch(e => { console.error(e); process.exit(1); });
