// Builds data/osaka-network.js from OpenStreetMap (Overpass API).
//   node tools/build-network.mjs
// Output is the auto-generated "network layer": stations (names, coordinates), lines (station order,
// straight-line segment distance) and numbered station exits. Hand-checked values (minutes, real track km,
// direction signs, tips, photos) live in index.html and override these.
// Map data © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright
import {writeFileSync, mkdirSync} from 'node:fs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

// One relation per line, in the direction the app treats as "forward" (dir 1).
// Relation IDs are stable; re-check them if OSM editors split or replace a route.
const LINES = {
  midosuji:    {rel:2411153, note:'Esaka → Nakamozu'},
  tanimachi:   {rel:444907,  note:'Dainichi → Yao-Minami'},
  yotsubashi:  {rel:8028854, note:'Nishi-Umeda → Suminoekoen'},
  chuo:        {rel:444881,  note:'Yumeshima → Nagata'},
  sennichimae: {rel:444891,  note:'Nodahanshin → Minami-Tatsumi'},
  sakaisuji:   {rel:444905,  note:'Tenjinbashisuji 6-chome → Tengachaya'},
  nagahori:    {rel:444878,  note:'Taisho → Kadoma-Minami'},
  imazatosuji: {rel:8028827, note:'Itakano → Imazato'}
  // New Tram (Nanko Port Town Line, rel 444913) left out: in OSM it lists only 7 of its 10 stops and two have no name.
};

// OSM spelling fixes, and IDs the app already uses for these stations
const FIX = {
  'Shitannoji-mae Yuhigaoka': 'Shitennoji-mae Yuhigaoka',
  'Tenjinbashisuji-rokuchome': 'Tenjinbashisuji 6-chome',
  'Minami-morimachi': 'Minami-Morimachi',
  'Cosmo Square': 'Cosmosquare'
};
const ID = {
  'Tanimachi 4-chome': 'tani4', 'Tanimachi 6-chome': 'tani6', 'Tanimachi 9-chome': 'tani9',
  'Shitennoji-mae Yuhigaoka': 'shitennojimae', 'Dobutsuen-mae': 'dobutsuen',
  'Tenjinbashisuji 6-chome': 'tenroku', 'Gamo 4-chome': 'gamo4', 'Zuiko 4-chome': 'zuiko4'
};
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const clean = s => { s = fold(s.split(';').pop()).replace(/\s+/g, ' ').trim(); return FIX[s] || s; };
const slug = s => ID[s] || s.split(/[^A-Za-z0-9]+/).filter(Boolean)
  .map((w, i) => i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join('');

const hav = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const r4 = x => Math.round(x * 1e4) / 1e4;

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
const els = await overpass(`[out:json][timeout:120];
relation(id:${ids})->.r; .r out body;
node(r.r)->.n; .n out body;
node(r.r:"stop")->.s;
node(around.s:400)["railway"="subway_entrance"]; out body;`);
const rels = Object.fromEntries(els.filter(e => e.type === 'relation').map(e => [e.id, e]));
const nodes = Object.fromEntries(els.filter(e => e.type === 'node').map(e => [e.id, e]));

const stations = {}, lines = {}, pos = {};
for(const [id, cfg] of Object.entries(LINES)){
  const rel = rels[cfg.rel]; if(!rel) throw new Error(`relation ${cfg.rel} (${id}) missing`);
  const stops = rel.members.filter(m => m.type === 'node' && /^stop/.test(m.role)).map(m => nodes[m.ref]).filter(Boolean);
  const st = [];
  for(const n of stops){
    const t = n.tags || {}, en = clean(t['name:en'] || t['name:ja-Latn'] || t.name || ''), sid = slug(en);
    if(!sid) throw new Error(`${id}: stop node ${n.id} has no usable English name`);
    (pos[sid] = pos[sid] || []).push([n.lat, n.lon]);
    stations[sid] = stations[sid] || {n:en, ja:(t['name:ja'] || t.name || '').replace(/駅$/, '')};
    if(st[st.length - 1] !== sid) st.push(sid);
  }
  if(st.length < 2) throw new Error(`${id}: only ${st.length} stops`);
  lines[id] = {st, colour:rel.tags.colour || null, ref:rel.tags.ref || null};
}
// a station's position = average of its stop nodes across lines
for(const [sid, ps] of Object.entries(pos)) stations[sid].ll = [r4(ps.reduce((a, p) => a + p[0], 0) / ps.length), r4(ps.reduce((a, p) => a + p[1], 0) / ps.length)];
// straight-line distance per segment, x1.15 for curves (hand-checked track km override this in the app)
for(const l of Object.values(lines)) l.km = l.st.slice(1).map((s, i) => Math.round(hav(stations[l.st[i]].ll, stations[s].ll) * 1.15 * 10) / 10);

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
for(const [id, l] of Object.entries(lines)) console.log(id.padEnd(12), l.st.length, 'stops:', l.st.join(' '));
