// Game identity — the ONE place the game's name lives.
// Rename the game here: the main menu title, the loading screen, the browser tab (<title>) and the
// end screen all read these values (index.html only carries placeholders marked data-brand="…").
export const GAME_NAME = 'Special Military Operation';
export const GAME_SUBTITLE = 'Company-level battles of the Russo-Ukrainian war';
export const GAME_TAGLINE = 'Take the ground, keep your people alive, and bleed the enemy until their line breaks.';

// Splits the name into (at most) two balanced lines for the big title treatment.
export function titleLines(name = GAME_NAME) {
  const w = name.trim().split(/\s+/); if (w.length < 2) return [name];
  let best = null;
  for (let i = 1; i < w.length; i++) {
    const a = w.slice(0, i).join(' '), b = w.slice(i).join(' '), score = Math.max(a.length, b.length);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best.lines;
}

// Fills every [data-brand] placeholder: name | subtitle | tagline | title (two-line display title).
export function applyBrand(root = document) {
  if (root === document) document.title = GAME_NAME;
  for (const el of root.querySelectorAll('[data-brand]')) {
    const k = el.dataset.brand;
    if (k === 'title') {
      el.textContent = '';
      titleLines().forEach((t, i) => { const s = document.createElement('span'); s.className = 'tl tl' + (i + 1); s.textContent = t; el.appendChild(s); });
      el.setAttribute('aria-label', GAME_NAME);
    } else el.textContent = k === 'subtitle' ? GAME_SUBTITLE : k === 'tagline' ? GAME_TAGLINE : GAME_NAME;
  }
}
