/* F-4 (HTML injection) and F-5 (E.164 phone handling).
 *
 * F-4 matters because lead data is not this application's own. It arrives from vendor CSVs, from the
 * agency's PUBLIC web quote form via Supabase (README: "a select * from quotes exported as CSV loads
 * into the queue as-is"), from other agents' uploads served back by the lead archive, and -- for
 * recording labels -- from `POST /recording-status`, a backend route with no Twilio signature
 * validation, so those values are attacker-supplied outright.
 *
 * The payloads below use an `onerror` that sets a global flag. jsdom does not fetch the broken image
 * that would fire it, so these assert on the RENDERED MARKUP: the payload must appear as escaped
 * text, and no live element may be created from it. That is the property that actually prevents
 * execution in a real browser.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDialer } = require('./harness.js');

const PAYLOAD = '<img src=x onerror="window.__pwned=1">';

/** Build a CSV whose name column carries the payload, and push it through the real importer. */
function csvWithName(name) {
  return `name,phone,city,state\n"${name.replace(/"/g, '""')}",+1 555 0142,Tampa,FL\n`;
}

/** Feed CSV text through the page's own parseCSV/rowsToLeads/replaceLeadList, then render. */
function loadCsv(d, csv) {
  d.win.__csv = csv;
  d.evalIn(`
    (function(){
      var rows = parseCSV(window.__csv);
      var out = rowsToLeads(rows);
      replaceLeadList(out.leads, 'test load');
    })()
  `);
}

test('F-4: a lead name containing markup is escaped in the queue, not rendered as an element', async () => {
  const d = await loadDialer();
  try {
    loadCsv(d, csvWithName(PAYLOAD));

    assert.strictEqual(d.evalIn('LEADS[0].name'), PAYLOAD, 'the importer keeps the raw value');

    const queue = d.$('#queue');
    assert.strictEqual(
      queue.querySelectorAll('img').length, 0,
      'no <img> element may be created from lead data — that is the injection'
    );
    assert.ok(
      queue.textContent.includes('onerror'),
      'the payload must survive as visible TEXT so the agent sees the real lead name'
    );
    assert.ok(
      queue.innerHTML.includes('&lt;img'),
      `the markup must be escaped in the DOM. Got: ${queue.innerHTML.slice(0, 160)}`
    );
    assert.strictEqual(d.win.__pwned, undefined, 'no payload may execute');
  } finally { d.close(); }
});

test('F-4: a lead name containing markup is escaped on the call stage', async () => {
  const d = await loadDialer();
  try {
    loadCsv(d, csvWithName(PAYLOAD));
    d.click('#startBtn'); // loads the first lead onto the stage

    const stage = d.$('#stageBody');
    assert.strictEqual(stage.querySelectorAll('img').length, 0, 'no element from lead data');
    assert.ok(stage.textContent.includes('onerror'), 'shown as text');
    assert.strictEqual(d.win.__pwned, undefined, 'no payload may execute');
  } finally { d.close(); }
});

test('F-4: a lead name containing markup is escaped in the session log', async () => {
  const d = await loadDialer();
  try {
    loadCsv(d, csvWithName(PAYLOAD));
    d.click('#startBtn'); // logs "Loaded <name> (<phone>)"

    const log = d.$('#log');
    assert.strictEqual(
      log.querySelectorAll('img').length, 0,
      'log() renders HTML by design, so lead data must be escaped at the call site'
    );
    assert.strictEqual(d.win.__pwned, undefined, 'no payload may execute');
  } finally { d.close(); }
});

test('F-4: a hostile recording label from the backend cannot execute (the B-2 chain)', async () => {
  // The real chain found in server.js: `POST /recording-status?leadName=<payload>` needs no
  // authentication and no Twilio signature, and the entry it creates is rendered by fetchRecordings()
  // when the agent presses Refresh. This stubs the backend response at the fetch boundary, which is
  // exactly what that unauthenticated POST would produce.
  const d = await loadDialer();
  try {
    d.evalIn(`S.twilio.backendUrl = 'https://backend.test'`);
    d.win.fetch = () => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        recordings: [{
          sid: 'RE00000000000000000000000000000000',
          duration: 42,
          leadName: PAYLOAD,
          session: null,
          createdAt: new Date().toISOString(),
        }],
      })),
    });

    d.click('#recordingsRefreshBtn');
    await d.wait(120);

    const list = d.$('#recordingsList');
    assert.ok(list.textContent.includes('onerror'), 'the label must render as text');
    assert.strictEqual(
      list.querySelectorAll('img').length, 0,
      'an unauthenticated backend POST must not be able to create an element in the agent tab'
    );
    assert.strictEqual(d.win.__pwned, undefined, 'no payload may execute');
  } finally { d.close(); }
});

test('F-4: a hostile archive filename cannot execute', async () => {
  const d = await loadDialer();
  try {
    d.evalIn(`S.twilio.backendUrl = 'https://backend.test'; S.twilio.identity = 'jane'`);
    d.win.fetch = () => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        archives: [{ id: 'a1', filename: PAYLOAD, leadCount: 3, uploadedAt: new Date().toISOString() }],
      })),
    });

    // Refresh is disabled until a real Connect succeeds, so drive the function the button calls.
    d.evalIn('fetchArchiveList()');
    await d.wait(120);

    const sel = d.$('#archiveSelect');
    assert.strictEqual(sel.querySelectorAll('img').length, 0, 'no element from a filename');
    assert.ok(sel.textContent.includes('onerror'), 'shown as text');
  } finally { d.close(); }
});

test('F-4: a hostile backend ERROR body cannot execute through the session log', async () => {
  // parseJsonResponse() deliberately quotes the first 150 characters of a non-JSON response so the
  // failure is diagnosable. That puts backend-controlled bytes inside an Error message, which then
  // reaches log() -- and log() renders HTML by design, for its own <b> emphasis. Found by auditing
  // the interpolation sites rather than by the tests above, so it gets its own case.
  const d = await loadDialer();
  try {
    d.evalIn(`S.twilio.backendUrl = 'https://backend.test'; S.twilio.identity = 'jane'`);
    d.win.fetch = () => Promise.resolve({
      ok: false,
      status: 502,
      text: () => Promise.resolve(`<html><body>${PAYLOAD}</body></html>`),
    });

    d.evalIn('fetchArchiveList()');
    await d.wait(120);

    const log = d.$('#log');
    assert.ok(log.textContent.includes('Archive list failed'), 'the failure is still reported');
    assert.strictEqual(
      log.querySelectorAll('img').length, 0,
      'a backend response body must not become live markup in the session log'
    );
    assert.strictEqual(d.win.__pwned, undefined, 'no payload may execute');
  } finally { d.close(); }
});

/* ---------------- F-5: E.164 ---------------- */

test('F-5: normalizePhone strips separators after a leading +', async () => {
  const d = await loadDialer();
  try {
    const cases = [
      // [input, expected]
      ['+1 555-0142',        '+15550142'],   // every built-in sample lead looks like this
      ['+1 (813) 555-0142',  '+18135550142'],
      ['+1.813.555.0142',    '+18135550142'],
      ['8135550142',         '+18135550142'], // bare 10-digit: the quote form's shape
      ['18135550142',        '+18135550142'],
      ['+44 20 7946 0958',   '+442079460958'], // international must not be assumed US
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(
        d.evalIn(`normalizePhone(${JSON.stringify(input)})`), expected,
        `normalizePhone(${JSON.stringify(input)})`
      );
    }
  } finally { d.close(); }
});

test('F-5: normalizePhone leaves genuinely ambiguous input alone rather than mangling it', async () => {
  const d = await loadDialer();
  try {
    for (const input of ['+1 555 0142 x22', '+1-555-CALL-NOW', 'not a phone']) {
      assert.strictEqual(
        d.evalIn(`normalizePhone(${JSON.stringify(input)})`), input,
        `${JSON.stringify(input)} must be passed through untouched, not guessed at`
      );
    }
  } finally { d.close(); }
});

test('F-5: every built-in sample lead is dialable after normalization', async () => {
  const d = await loadDialer();
  try {
    const bad = d.evalIn(`
      JSON.stringify(LEADS.filter(function(L){ return !E164.test(normalizePhone(L.phone)); })
                          .map(function(L){ return L.name + ': ' + L.phone; }))
    `);
    assert.strictEqual(bad, '[]', `these sample numbers would be rejected by Twilio: ${bad}`);
  } finally { d.close(); }
});

test('F-5: the live path refuses a malformed number instead of handing it to Twilio', async () => {
  const d = await loadDialer();
  try {
    // Open both live gates with a stub device, then point the loaded lead at a number Twilio rejects.
    let connectCalls = 0;
    d.evalIn(`
      S.twilio.liveEnabled = true;
      S.twilio.device = { connect: function(){ window.__connectCalls = (window.__connectCalls||0)+1;
                                               return Promise.resolve({ on: function(){} }); } };
    `);
    d.click('#startBtn');
    d.evalIn(`LEADS[S.idx].phone = 'not-a-number'; S.phase = 'ready';`);
    const dialedBefore = d.evalIn('S.stats.dialed');

    d.evalIn('startDial()');
    await d.wait(60);

    connectCalls = d.win.__connectCalls || 0;
    assert.strictEqual(connectCalls, 0, 'device.connect() must not be called with a malformed number');
    assert.strictEqual(
      d.evalIn('S.stats.dialed'), dialedBefore,
      'a refused dial must not be counted — the guard runs before any state changes'
    );
    assert.strictEqual(d.evalIn('S.phase'), 'ready', 'the lead stays ready to retry, not stuck dialing');
    assert.ok(d.$('#log').textContent.includes('Refused to dial'), 'the refusal must be visible');
  } finally { d.close(); }
});
