// The color tokens of both themes keep text readable and layers apart.
// Ratios are WCAG contrast ratios, computed from the stylesheets themselves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const channel = value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => channel(parseInt(hex.slice(i, i + 2), 16) / 255)); return .2126 * r + .7152 * g + .0722 * b; };
const contrast = (a, b) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + .05) / (dark + .05); };
const mix = (a, b, share) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * share + parseInt(b.slice(i, i + 2), 16) * (1 - share)).toString(16).padStart(2, '0')).join('');
const full = hex => hex.length === 4 ? '#' + [...hex.slice(1)].map(c => c + c).join('') : hex;

// The light tokens come first; the dark block overrides some of them.
function themes(css) {
  const at = css.indexOf('@media (prefers-color-scheme: dark)'), end = css.indexOf('}\n}', at);
  const tokens = text => Object.fromEntries([...text.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,8}|\d+%)\s*;/gi)].map(([, name, value]) => [name, value.startsWith('#') ? full(value) : value]));
  const light = tokens(css.slice(0, at));
  return { light, dark: { ...light, ...tokens(css.slice(at, end)) } };
}

const categories = ['#4c68a0', '#846099', '#397f72', '#b26835', '#ad5779'];

test('planner text keeps its contrast on every layer, in light and dark', () => {
  const { light, dark } = themes(read('../web/styles.css'));
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const check = (what, fg, bg, least) => assert.ok(contrast(fg, bg) >= least, name + ': ' + what + ' is ' + contrast(fg, bg).toFixed(2) + ', needs ' + least);
    for (const [layer, bg] of [['page', t.paper], ['panel', t.surface], ['meeting block', t['surface-muted']]]) {
      check('text on ' + layer, t.ink, bg, 12);
      check('secondary text on ' + layer, t.muted, bg, 7);
      check('quiet text on ' + layer, t.quiet, bg, 5);
      check('links on ' + layer, t['accent-dark'], bg, 6);
      check('problem text on ' + layer, t.warn, bg, 5);
    }
    check('selected day', t['accent-dark'], t['accent-light'], 6);
    check('primary button label', t['primary-ink'], t.accent, 4.5);
    check('check mark', t.paper, t['check-fill'], 4.5);
    check('problem text on its box', t.warn, t['warn-light'], 5);
    check('field border', t['field-line'], t.surface, 3);
    // A task card is the panel tinted with its type's color; its text and its edge stay clear.
    const base = parseInt(t['category-base']) / 100, wash = parseInt(t['task-wash']) / 100;
    for (const color of categories) {
      const edge = mix(color, '#ffffff', base), card = mix(edge, t.surface, wash);
      check('text on a ' + color + ' task card', t.ink, card, 10);
      check('quiet text on a ' + color + ' task card', t.quiet, card, 5);
      check('edge of a ' + color + ' task card', edge, card, 3);
    }
  }
  // Dark mode: each layer is visibly lighter than the one below it, and rules can be seen.
  assert.ok(contrast(dark.surface, dark.paper) >= 1.12);
  assert.ok(contrast(dark['surface-muted'], dark.paper) >= 1.3);
  assert.ok(contrast(dark['surface-muted'], dark.surface) >= 1.1);
  assert.ok(contrast(dark.line, dark.paper) >= 2.2);
  assert.ok(luminance(dark.paper) < luminance(dark.surface) && luminance(dark.surface) < luminance(dark['surface-muted']));
});

test('the public booking page follows the same rules', () => {
  const { light, dark } = themes(read('../relay/public/assets/booking.css'));
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const check = (what, fg, bg, least) => assert.ok(contrast(fg, bg) >= least, name + ': ' + what + ' is ' + contrast(fg, bg).toFixed(2) + ', needs ' + least);
    for (const bg of [t.bg, t.card]) { check('text', t.text, bg, 12); check('secondary text', t.muted, bg, 7); check('links', t.accent, bg, 6); check('errors', t.danger, bg, 5); }
    check('button label', t['accent-text'], t.accent, 6);
    check('chosen time', t.text, t['accent-soft'], 10);
    check('notice', t.text, t.notice, 10);
  }
});
