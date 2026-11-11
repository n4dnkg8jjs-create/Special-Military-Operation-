(() => { const w = game.city, L = w.osm.lines.filter(l => /rail/.test(l.t)), V = []; let cross = null, curve = null, side = null;
  for (const l of L) for (let i = 1; i < l.pts.length - 1; i++) { const [x, z] = l.pts[i]; const a = w.paved.asphalt(x, z);
    if (!cross && a < -1) cross = [x, z, 30, 0.75, 0.6];
    const [ax, az] = l.pts[i - 1], [bx, bz] = l.pts[i + 1], t1 = Math.atan2(z - az, x - ax), t2 = Math.atan2(bz - z, bx - x), dt = Math.abs(((t2 - t1 + 9.42) % 6.283) - 3.14);
    if (!curve && dt > 0.25 && a > 4) curve = [x, z, 28, 0.8, 0.3];
    if (!side && l.t === 'rail_old' && a > 1 && a < 4) side = [x, z, 35, 0.7, 1.2]; }
  return [cross, curve, side].filter(Boolean); })()
