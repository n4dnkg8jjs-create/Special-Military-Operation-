// Summarise tools/ai_bench.mjs results (previews/ai_v2/r_*.json) into a markdown table: old vs new per scenario.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2] || 'previews/ai_v2';
const rows = fs.readdirSync(dir).filter(f => /^r_.*\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
rows.sort((a, b) => `${a.map}${a.mode}${a.seed}${a.ai}`.localeCompare(`${b.map}${b.mode}${b.seed}${b.ai}`));
const out = ['| scenario | seed | AI | t | tickets P–E | objectives | E kia/veh | P kia/veh | E caps | kia per E cap | fire-supported caps | retakes (s) | hidden-move % | spotted-move % | flank % | smoke | strikes | reserve | ops (taken/failed) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
for (const r of rows) {
  const caps = r.enemyCaps || [], n = caps.length;
  const kpc = n ? (caps[n - 1].kia / n).toFixed(1) : '–';
  const sup = n ? `${caps.filter(c => c.smoke || c.strike).length}/${n}` : '–';
  const ops = r.aiStats?.ops ? `${r.aiStats.ops.filter(o => o.res === 'taken').length}/${r.aiStats.ops.filter(o => /fail|timed/.test(o.res || '')).length} of ${r.aiStats.ops.length}` : '–';
  const res = r.aiStats?.reserveCommits ? r.aiStats.reserveCommits.map(c => `${c.t}s ${c.obj} ${c.why}`).join('; ') || 'none' : '–';
  out.push(`| ${r.map} ${r.mode} | ${r.seed} | ${r.ai} | ${r.time}${r.over ? ' ' + r.result : ''} | ${r.tickets.player}–${r.tickets.enemy} | ${r.objectives} | ${r.stats.enemy.kia}/${r.stats.enemy.vehLost} | ${r.stats.player.kia}/${r.stats.player.vehLost} | ${n} | ${kpc} | ${sup} | ${(r.retake || []).map(x => x.join(':')).join(' ') || '–'} | ${r.coverMoveFrac != null ? Math.round(r.coverMoveFrac * 100) : '–'} | ${r.spottedMoveFrac != null ? Math.round(r.spottedMoveFrac * 100) : '–'} | ${r.flankFrac != null ? Math.round(r.flankFrac * 100) + ` (${r.approaches})` : '–'} | ${r.smoke} | ${r.strikes} | ${res} | ${ops} |`);
}
console.log(out.join('\n'));
