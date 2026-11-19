// Builds data/osaka-network.js from OpenStreetMap (Overpass API).
//   node tools/build-network.mjs
// Output is the auto-generated "network layer": stations (names, coordinates), lines (station order,
// straight-line segment distance) and numbered station exits. Hand-checked values (minutes, real track km,
// direction signs, tips, photos, fares) live in index.html and override these.
// Map data © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright
import {writeFileSync, mkdirSync} from 'node:fs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

// Areas lines are clipped to (south, west, north, east). Lines to Kyoto, Nara and Kobe use span instead.
const AREA = {
  osaka: [34.55, 135.38, 34.78, 135.62],
  airport: [34.38, 135.22, 34.78, 135.62]       // Osaka + the Kansai Airport corridor
};

// One OSM route relation per line or train type. Relation IDs are stable; re-check if OSM editors replace a route.
// op = fare operator. area = clip to that box (keeps the longest run of stops inside). from = drop stops before it.
// span = [stop A, stop B]: keep only the stops from A to B (either order) — used for the day-trip lines.
const LINES = {
  // Osaka Metro (whole lines)
  midosuji:    {rel:2411153, op:'metro'},
  tanimachi:   {rel:444907,  op:'metro'},
  yotsubashi:  {rel:8028854, op:'metro'},
  chuo:        {rel:444881,  op:'metro'},
  sennichimae: {rel:444891,  op:'metro'},
  sakaisuji:   {rel:444905,  op:'metro'},
  nagahori:    {rel:444878,  op:'metro'},
  imazatosuji: {rel:8028827, op:'metro'},
  // New Tram (rel 444913) left out: in OSM it lists only 7 of its 10 stops and two have no name.

  // JR West
  jrLoop:      {rel:10073682, op:'jr', loop:true},      // outer loop (clockwise)
  jrYume:      {rel:6088924,  op:'jr'},
  jrKyoto:     {rel:11808754, op:'jr', span:['Kyoto', 'Osaka']},   // local, Kyoto → Osaka
  jrKobe:      {rel:16784421, op:'jr', span:['Osaka', 'Kobe']},
  jrTozai:     {rel:11816511, op:'jr'},
  jrYamatoji:  {rel:11810048, op:'jr', area:'osaka'},     // local (JR Namba–Koriyama); Yamatoji Rapid to Nara is hand-written
  jrHigashi:   {rel:3344075,  op:'jr', area:'osaka'},
  jrAir:       {rel:18630327, op:'jr', area:'airport'},  // Kansai Airport Rapid
  // Nankai
  nankai:      {rel:11930463, op:'nankai', area:'osaka'},   // main line local
  nankaiAir:   {rel:18668905, op:'nankai', area:'airport'}, // Airport Express
  rapit:       {rel:18673505, op:'nankai', area:'airport'}, // Rapi:t α
  // Hanshin
  hanshin:     {rel:11923501, op:'hanshin'},                 // Namba Line (relation lists both directions)
  hanshinMain: {rel:11658109, op:'hanshin', span:['Osaka-Umeda', 'Kobe-Sannomiya']},
  // Hankyu
  hankyuKyoto: {rel:10255877, op:'hankyu', span:['Osaka-Umeda', 'Kyoto-kawaramachi']},
  hankyuKobe:  {rel:11966252, op:'hankyu', span:['Osaka-Umeda', 'Kobe-Sannomiya']},
  hankyuTakarazuka: {rel:11982564, op:'hankyu', area:'osaka'},
  hankyuSenri: {rel:1872144,  op:'hankyu', area:'osaka'},
  // Kintetsu
  kintetsuNara:  {rel:18665645, op:'kintetsu', span:['Osaka Namba', 'Kintetsu-Nara']},  // rapid express
  kintetsuOsaka: {rel:11962196, op:'kintetsu', area:'osaka'},
  kintetsuMinami:{rel:11942103, op:'kintetsu', area:'osaka'}
  // Keihan main line: no route relation in OSM yet (only the Uji and Katano branches) — to be written by hand.
};

// English names for stops that have none in OSM, and spelling fixes
const JA_EN = {
  '大阪梅田':'Osaka-Umeda', '福島':'Fukushima', '淀川':'Yodogawa', '千船':'Chibune', '杭瀬':'Kuise', '尼崎':'Amagasaki',
  '西九条':'Nishikujo', '熊取':'Kumatori', '堺市':'Sakaishi', 'JR淡路':'JR-Awaji', '川西能勢口':'Kawanishi-Noseguchi',
  '吹田':'Suita', '長岡京駅2番のりば':'Nagaokakyo', '長岡京駅1番のりば':'Nagaokakyo'
};
const FIX = {
  'Shitannoji-mae Yuhigaoka': 'Shitennoji-mae Yuhigaoka', 'Tenjinbashisuji-rokuchome': 'Tenjinbashisuji 6-chome',
  'Minami-morimachi': 'Minami-Morimachi', 'Cosmo Square': 'Cosmosquare', 'Shin-Imaimiya': 'Shin-Imamiya',
  'Kishinosato-tamade': 'Kishinosato-Tamade', 'Rinku Town': 'Rinku Town'
};
// station IDs the app already uses, and same-name stations of different companies kept apart
const ID = {
  'Tanimachi 4-chome': 'tani4', 'Tanimachi 6-chome': 'tani6', 'Tanimachi 9-chome': 'tani9',
  'Shitennoji-mae Yuhigaoka': 'shitennojimae', 'Dobutsuen-mae': 'dobutsuen', 'Tenjinbashisuji 6-chome': 'tenroku',
  'Gamo 4-chome': 'gamo4', 'Zuiko 4-chome': 'zuiko4', 'Kansai Airport': 'kix', 'Osaka Namba': 'osakaNamba',
  'nankai:Namba': 'nankaiNamba', 'hankyu:Osaka-Umeda': 'hankyuUmeda', 'hanshin:Osaka-Umeda': 'hanshinUmeda',
  'hanshin:Amagasaki': 'hanshinAmagasaki', 'hankyu:Suita': 'hankyuSuita', 'hankyu:Nakatsu': 'hankyuNakatsu', 'kintetsu:Kintetsu-Nippombashi': 'nippombashi', 'Osaka Uehommachi': 'uehommachi',
  'Osaka Abenobashi': 'abenobashi', 'Kintetsu-Nara': 'kNara', 'hankyu:Kobe-Sannomiya': 'hankyuSannomiya',
  'hanshin:Kobe-Sannomiya': 'hanshinSannomiya'
};
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const clean = s => { s = fold(s.split(';').pop()).replace(/\s+/g, ' ').trim(); return FIX[s] || s; };
const norm = s => s.toLowerCase().replace(/[^a-z0-9:]/g, '');   // 'Kobe Sannomiya' = 'Kobe-Sannomiya'
const NID = Object.fromEntries(Object.entries(ID).map(([k, v]) => [norm(k), v]));
const slug = (s, op) => NID[norm(`${op}:${s}`)] || NID[norm(s)] || s.split(/[^A-Za-z0-9]+/).filter(Boolean)
  .map((w, i) => i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join('');

const hav = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const r4 = x => Math.round(x * 1e4) / 1e4;
const inside = (n, box) => n.lat >= box[0] && n.lon >= box[1] && n.lat <= box[2] && n.lon <= box[3];

async function overpass(q){
  for(let attempt = 1; attempt <= 4; attempt++){
    const res = await fetch(OVERPASS, {method:'POST', headers:{'User-Agent':'osaka-route-finder-build/0.1'}, body:new URLSearchParams({data:q})});
    if(res.ok){ const j = await res.json(); if(j.elements && j.elements.length) return j.elements; }
    console.warn(`overpass attempt ${attempt} failed (${res.status}), retrying…`);
    await new Promise(r => setTimeout(r, 15000 * attempt));
  }
  throw new Error('Overpass query failed');
}

const ids = Object.values(LINES).map(l => l.rel).join(',');
const els = await overpass(`[out:json][timeout:180];
relation(id:${ids})->.r; .r out body;
node(r.r)->.n; .n out body;
node(r.r:"stop")->.s;
node(around.s:400)["railway"="subway_entrance"]; out body;`);
const rels = Object.fromEntries(els.filter(e => e.type === 'relation').map(e => [e.id, e]));
const nodes = Object.fromEntries(els.filter(e => e.type === 'node').map(e => [e.id, e]));

const stations = {}, lines = {}, pos = {}, first = {}, renamed = new Set();
for(const [id, cfg] of Object.entries(LINES)){
  const rel = rels[cfg.rel]; if(!rel) throw new Error(`relation ${cfg.rel} (${id}) missing`);
  let stops = rel.members.filter(m => m.type === 'node' && /^stop/.test(m.role)).map(m => nodes[m.ref]).filter(Boolean);
  const named = stops.map(n => { const t = n.tags || {}, raw = t['name:en'] || t['name:ja-Latn'] || JA_EN[t.name] || '';
    const en = clean(raw); if(!en) throw new Error(`${id}: stop "${t.name}" (${n.id}) has no English name; add it to JA_EN`);
    return {n, en, ja:(t['name:ja'] || t.name || '').replace(/駅$/, '').replace(/駅\d番のりば$/, ''), sid:slug(en, cfg.op)}; });
  let run = named;
  // relation that lists both directions: stop at the first station seen twice
  const seen = new Set(); const cut = run.findIndex(s => seen.has(s.sid) || !seen.add(s.sid));
  if(cut > 0 && !cfg.loop) run = run.slice(0, cut);
  if(cfg.from){ const k = run.findIndex(s => s.en === cfg.from); if(k < 0) throw new Error(`${id}: from ${cfg.from} not found`); run = run.slice(k); }
  if(cfg.span){
    const at = cfg.span.map(nm => run.findIndex(s => norm(s.en) === norm(nm)));
    if(at.some(k => k < 0)) throw new Error(`${id}: span stop not found (${cfg.span}); stops: ${run.map(s => s.en).join(', ')}`);
    run = run.slice(Math.min(...at), Math.max(...at) + 1);
  }
  if(cfg.area){   // longest run of consecutive stops inside the area
    let best = [], cur = [];
    for(const s of run){ if(inside(s.n, AREA[cfg.area])) cur.push(s); else { if(cur.length > best.length) best = cur; cur = []; } }
    run = cur.length > best.length ? cur : best;
  }
  const st = [];
  for(const s of run){
    const at = first[s.sid];
    if(at && at.op !== cfg.op && hav(at.ll, [s.n.lat, s.n.lon]) > .6){
      const alt = cfg.op + s.sid[0].toUpperCase() + s.sid.slice(1);
      if(!renamed.has(alt)){ renamed.add(alt); console.log(`split ${s.sid} → ${alt} (${at.op} vs ${cfg.op})`); }
      s.sid = alt;
    }
    first[s.sid] = first[s.sid] || {op:cfg.op, ll:[s.n.lat, s.n.lon]};
    (pos[s.sid] = pos[s.sid] || []).push([s.n.lat, s.n.lon]);
    stations[s.sid] = stations[s.sid] || {n:s.en, ja:s.ja};
    if(st[st.length - 1] !== s.sid) st.push(s.sid);
  }
  if(cfg.loop && st.length > 2 && st[0] === st[st.length - 1]) st.pop();
  if(st.length < 2) throw new Error(`${id}: only ${st.length} stops`);
  lines[id] = {st, op:cfg.op, loop:!!cfg.loop, colour:rel.tags.colour || null, ref:rel.tags.ref || null};
}
// a station's position = average of its stop nodes across lines
for(const [sid, ps] of Object.entries(pos)) stations[sid].ll = [r4(ps.reduce((a, p) => a + p[0], 0) / ps.length), r4(ps.reduce((a, p) => a + p[1], 0) / ps.length)];
// straight-line distance per segment, x1.15 for curves (hand-checked track km override this in the app)
for(const l of Object.values(lines)){
  const segs = l.loop ? l.st.length : l.st.length - 1;
  l.km = Array.from({length:segs}, (_, i) => Math.round(hav(stations[l.st[i]].ll, stations[l.st[(i + 1) % l.st.length]].ll) * 1.15 * 10) / 10);
}

// numbered exits, attached to the nearest station within 400 m
const exits = {};
for(const n of els.filter(e => e.type === 'node' && e.tags && e.tags.railway === 'subway_entrance' && e.tags.ref)){
  let best = null, bd = 0.4;
  for(const [sid, s] of Object.entries(stations)){ const d = hav([n.lat, n.lon], s.ll); if(d < bd){ bd = d; best = sid; } }
  if(!best) continue;
  const ref = n.tags.ref.split(';')[0].trim();
  const list = exits[best] = exits[best] || [];
  if(!list.some(x => x[0] === ref)) list.push([ref, r4(n.lat), r4(n.lon)]);
}

const out = {city:'osaka', built:new Date().toISOString().slice(0, 10), source:'© OpenStreetMap contributors (ODbL)', stations, lines, exits};
mkdirSync(new URL('../data/', import.meta.url), {recursive:true});
writeFileSync(new URL('../data/osaka-network.js', import.meta.url),
  `// AUTO-GENERATED by tools/build-network.mjs — do not edit by hand.\n// Map data © OpenStreetMap contributors, ODbL 1.0.\n` +
  `window.NETWORK = window.NETWORK || {};\nwindow.NETWORK.osaka = ${JSON.stringify(out)};\n`);
console.log(`stations ${Object.keys(stations).length}, lines ${Object.keys(lines).length}, exits ${Object.values(exits).reduce((a, l) => a + l.length, 0)}`);
for(const [id, l] of Object.entries(lines)) console.log(id.padEnd(16), String(l.st.length).padStart(2), l.st.join(' '));
