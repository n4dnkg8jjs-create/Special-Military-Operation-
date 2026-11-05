// Old-vs-new aggregate over tools/ai_bench.mjs result files: node tools/ai_bench_compare.mjs <dir> [prefixOld] [prefixNew]
// Pairs runs by map/mode/seed; prints per-scenario means and the overall mean of: enemy tickets left, player tickets
// left, objectives held by the enemy at the end, enemy captures (objective flips to the enemy), enemy / player KIA,
// vehicles lost, enemy wins.
import fs from 'node:fs';
import path from 'node:path';
const [dir = 'previews/ai_v2/b2', pOld = 'fin', pNew = 'fin'] = process.argv.slice(2);
const load = pre => fs.readdirSync(dir).filter(f => f.startsWith(pre + '_') && f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter(r => r.tickets);
const key = r => `${r.map} ${r.mode}`;
const m = (rs, f) => rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : NaN;
const met = {
  'E tickets': r => r.tickets.enemy, 'P tickets': r => r.tickets.player, 'E margin': r => r.tickets.enemy - r.tickets.player,
  'E obj held': r => (r.objectives.match(/:enemy/g) || []).length, 'E caps': r => (r.caps || []).filter(c => c[3] === 'enemy').length,
  'E kia': r => r.stats.enemy.kia, 'P kia': r => r.stats.player.kia, 'E veh': r => r.stats.enemy.vehLost, 'P veh': r => r.stats.player.vehLost,
  'E wins': r => (r.tickets.enemy > r.tickets.player ? 1 : 0),
};
const O = load(pOld).filter(r => r.ai === 'old'), N = load(pNew).filter(r => r.ai === 'new'), seeds = new Set([...O, ...N].map(r => `${key(r)}#${r.seed}`));
const paired = [...seeds].filter(s => O.some(r => `${key(r)}#${r.seed}` === s) && N.some(r => `${key(r)}#${r.seed}` === s));
const P = rs => rs.filter(r => paired.includes(`${key(r)}#${r.seed}`));
const scen = [...new Set(paired.map(s => s.split('#')[0]))].sort();
const cols = Object.keys(met);
const lines = [`| scenario | n | ${cols.map(c => `${c} v1 / v2`).join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`];
for (const sc of [...scen, 'ALL']) {
  const o = P(O).filter(r => sc === 'ALL' || key(r) === sc), n = P(N).filter(r => sc === 'ALL' || key(r) === sc);
  lines.push(`| ${sc === 'ALL' ? '**ALL**' : sc} | ${o.length} | ${cols.map(c => `${m(o, met[c]).toFixed(c === 'E obj held' || c === 'E caps' || c === 'E wins' || c.includes('veh') ? 2 : 0)} / ${m(n, met[c]).toFixed(c === 'E obj held' || c === 'E caps' || c === 'E wins' || c.includes('veh') ? 2 : 0)}`).join(' | ')} |`);
}
console.log(lines.join('\n'));
const unp = [...seeds].filter(s => !paired.includes(s)); if (unp.length) console.log(`\nunpaired: ${unp.join(', ')}`);
