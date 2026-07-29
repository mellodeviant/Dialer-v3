/* Test harness for index.html.
 *
 * The dialer is one self-contained file whose script runs on load, so the harness loads that real
 * file into jsdom rather than re-implementing any of it. Two things make it testable:
 *
 *   1. DETERMINISTIC RANDOMNESS. Every branch that matters (does a leg answer? how long does it
 *      ring?) goes through Math.random(). `randomSequence` replaces it with a queue, so a test
 *      states the exact call outcome it wants instead of retrying until the dice cooperate.
 *
 *   2. READING THE SCRIPT'S OWN STATE. `S`, `LEADS` and `PD` are declared with `let` at the top
 *      level of a classic script, which puts them in the global LEXICAL environment -- they are
 *      never properties of `window`, so `win.S` is undefined. A global eval shares that
 *      environment, so `evalIn('S.stats.abandoned')` reaches them. This is the only way to observe
 *      internals without editing the file to suit its tests.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');

/** Load the dialer into a fresh jsdom window.
 *  @param {number[]} randomSequence values Math.random() returns, in order; falls back to `randomDefault` once exhausted.
 *  @param {number} randomDefault value used after the sequence runs out.
 */
async function loadDialer({ randomSequence = [], randomDefault = 0.99 } = {}) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://dialer.test/',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // The inline script runs during construction; wait for the document to settle before touching it.
  await new Promise((resolve) => {
    if (win.document.readyState === 'complete') return resolve();
    win.addEventListener('load', resolve, { once: true });
    setTimeout(resolve, 200); // the Twilio CDN <script> never resolves offline; don't hang on it
  });

  const queue = [...randomSequence];
  const drawn = [];
  win.Math.random = () => {
    const v = queue.length ? queue.shift() : randomDefault;
    drawn.push(v);
    return v;
  };

  const evalIn = (expr) => win.eval(expr);
  const $ = (sel) => win.document.querySelector(sel);
  const $$ = (sel) => [...win.document.querySelectorAll(sel)];
  const text = (sel) => { const el = $(sel); return el ? el.textContent : null; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Tick power-dial checkboxes for the given lead ids, firing the change handler the page wires up. */
  const selectLeads = (ids) => {
    for (const id of ids) {
      const cb = $(`.pdCheck[data-id="${id}"]`);
      if (!cb) throw new Error(`No power-dial checkbox for lead ${id} — is it blocked or already done?`);
      cb.checked = true;
      cb.dispatchEvent(new win.Event('change'));
    }
  };

  const click = (sel) => {
    const el = $(sel);
    if (!el) throw new Error(`No element ${sel}`);
    if (el.disabled) throw new Error(`${sel} is disabled`);
    el.click();
  };

  return { dom, win, evalIn, $, $$, text, wait, selectLeads, click, drawn,
           close: () => dom.window.close() };
}

module.exports = { loadDialer };
