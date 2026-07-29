/* Call history and the recording toggle — owner requests of 2026-07-29.
 *
 *   "a section where we can view+listen to all the calls made, in order of time dialed, listed by
 *    name of client and number, with additional filter features (so we could click it and see all
 *    the calls to or from 1 number, or seeing calls in vs calls out)"
 *
 *   "we need it always on and always stored, add a function/button where someone can turn it off
 *    when solo-dialing but leave it always on for the power dialer"
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDialer } = require('./harness.js');

const ANSWER = 0.30;

/** Work one lead to a saved disposition, so a history row exists. */
function completeOneLead(d, dispo) {
  d.click('#startBtn');
  d.evalIn(`S.phase='wrapup'; S.attempted=true; S.dispo=${JSON.stringify(dispo)}; renderDispo();`);
  d.click('#saveBtn');
}

test('history lists completed calls newest first, with client name and number', async () => {
  const d = await loadDialer();
  try {
    completeOneLead(d, 'appointment');

    const rows = d.evalIn('JSON.stringify(callHistory().map(function(r){return [r.name,r.number,r.outcome,r.direction]}))');
    const parsed = JSON.parse(rows);
    assert.strictEqual(parsed.length, 1, `expected one history row, got ${rows}`);
    assert.strictEqual(parsed[0][0], 'Dorothy Whitfield', 'listed by client name');
    assert.strictEqual(parsed[0][1], '+1 555-0142', 'listed with the number');
    assert.strictEqual(parsed[0][2], 'Appointment set', 'carries the outcome');
    assert.strictEqual(parsed[0][3], 'out', 'direction is recorded');

    const panel = d.$('#historyList').textContent;
    assert.ok(panel.includes('Dorothy Whitfield'), 'rendered in the panel');
    assert.ok(panel.includes('Appointment set'), 'outcome rendered');
    assert.ok(d.text('#histCount').includes('1 of 1'), `count line: ${d.text('#histCount')}`);
  } finally { d.close(); }
});

test('history is ordered by time dialed, newest first', async () => {
  const d = await loadDialer();
  try {
    // Two completed leads with explicit, out-of-order timestamps.
    d.evalIn(`
      S.done['L-1041'] = {dispo:'no-answer', label:'No answer', at:'2026-07-29T10:00:00.000Z',
                          direction:'out', talkSeconds:10, note:null, agent:null};
      S.done['L-1042'] = {dispo:'appointment', label:'Appointment set', at:'2026-07-29T12:00:00.000Z',
                          direction:'out', talkSeconds:90, note:null, agent:null};
      renderHistory();
    `);
    const names = JSON.parse(d.evalIn('JSON.stringify(callHistory().map(function(r){return r.name}))'));
    assert.deepStrictEqual(names, ['Marcus Bell', 'Dorothy Whitfield'], 'newest (12:00) first');
  } finally { d.close(); }
});

test('clicking a number filters history to calls to or from that number', async () => {
  const d = await loadDialer();
  try {
    d.evalIn(`
      S.done['L-1041'] = {dispo:'no-answer', label:'No answer', at:'2026-07-29T10:00:00.000Z', direction:'out', talkSeconds:0};
      S.done['L-1042'] = {dispo:'appointment', label:'Appointment set', at:'2026-07-29T11:00:00.000Z', direction:'out', talkSeconds:5};
      renderHistory();
    `);
    assert.strictEqual(d.evalIn('filteredHistory().length'), 2, 'both visible before filtering');

    const btns = d.$$('.histNum');
    assert.ok(btns.length >= 2, 'each row exposes its number as a filter control');
    btns.find(b => b.dataset.num === '+1 555-0177').click();

    const shown = JSON.parse(d.evalIn('JSON.stringify(filteredHistory().map(function(r){return r.number}))'));
    assert.deepStrictEqual(shown, ['+1 555-0177'], 'only that number remains');
    assert.strictEqual(d.$('#histSearch').value, '+1 555-0177', 'the filter box reflects the click');
  } finally { d.close(); }
});

test('number search ignores formatting differences', async () => {
  const d = await loadDialer();
  try {
    d.evalIn(`
      S.done['L-1041'] = {dispo:'no-answer', label:'No answer', at:'2026-07-29T10:00:00.000Z', direction:'out', talkSeconds:0};
      renderHistory();
    `);
    // An agent pasting digits off a callback slip must still find "+1 555-0142".
    d.evalIn(`histFilter.q = '5550142'; renderHistory();`);
    assert.strictEqual(d.evalIn('filteredHistory().length'), 1, 'digits-only search matches a formatted number');
  } finally { d.close(); }
});

test('the calls-in vs calls-out filter works, and inbound is honestly empty', async () => {
  const d = await loadDialer();
  try {
    d.evalIn(`
      S.done['L-1041'] = {dispo:'no-answer', label:'No answer', at:'2026-07-29T10:00:00.000Z', direction:'out', talkSeconds:0};
      renderHistory();
    `);
    d.evalIn(`histFilter.direction = 'out'; renderHistory();`);
    assert.strictEqual(d.evalIn('filteredHistory().length'), 1, 'outbound filter finds the call');

    d.evalIn(`histFilter.direction = 'in'; renderHistory();`);
    assert.strictEqual(
      d.evalIn('filteredHistory().length'), 0,
      'no inbound calls exist yet — server.js sets incomingAllow:false, so this must be empty rather than wrong'
    );
    assert.ok(d.$('#historyList').textContent.includes('No calls match'), 'empty state explains itself');
  } finally { d.close(); }
});

test('the outcome filter is generated from DISPO_LABEL and filters correctly', async () => {
  const d = await loadDialer();
  try {
    const opts = d.$$('#histOutcome option').map(o => o.value).filter(Boolean);
    const labels = Object.keys(JSON.parse(d.evalIn('JSON.stringify(DISPO_LABEL)')));
    assert.deepStrictEqual(opts, labels, 'options track DISPO_LABEL so the two cannot drift');

    d.evalIn(`
      S.done['L-1041'] = {dispo:'no-answer', label:'No answer', at:'2026-07-29T10:00:00.000Z', direction:'out', talkSeconds:0};
      S.done['L-1042'] = {dispo:'appointment', label:'Appointment set', at:'2026-07-29T11:00:00.000Z', direction:'out', talkSeconds:5};
      histFilter.outcome = 'appointment'; renderHistory();
    `);
    const shown = JSON.parse(d.evalIn('JSON.stringify(filteredHistory().map(function(r){return r.dispo}))'));
    assert.deepStrictEqual(shown, ['appointment']);
  } finally { d.close(); }
});

test('Clear resets every filter', async () => {
  const d = await loadDialer();
  try {
    d.evalIn(`
      S.done['L-1041'] = {dispo:'no-answer', label:'No answer', at:'2026-07-29T10:00:00.000Z', direction:'out', talkSeconds:0};
      histFilter.q='zzz'; histFilter.direction='in'; histFilter.outcome='appointment'; renderHistory();
    `);
    assert.strictEqual(d.evalIn('filteredHistory().length'), 0);
    d.click('#histClearBtn');
    assert.strictEqual(d.evalIn('filteredHistory().length'), 1, 'the call is visible again');
    assert.strictEqual(d.$('#histSearch').value, '', 'search box cleared');
  } finally { d.close(); }
});

test('a recording with no matching call still appears, rather than being hidden', async () => {
  const d = await loadDialer();
  try {
    d.evalIn(`
      S.twilio.backendUrl = 'https://backend.test';
      RECORDINGS = [{ sid:'RE1', duration:75, leadId:null, leadName:'Walk-in caller',
                      session:null, createdAt:'2026-07-29T09:00:00.000Z' }];
      renderHistory();
    `);
    assert.strictEqual(d.evalIn('callHistory().length'), 1, 'the orphan recording is surfaced');
    const audio = d.$$('#historyList audio');
    assert.strictEqual(audio.length, 1, 'and it is playable');
    assert.ok(audio[0].getAttribute('src').includes('/recordings/RE1/audio'),
      'playback goes through the backend audio proxy, never a Twilio-authenticated URL');
  } finally { d.close(); }
});

test('a recording is attached to the call it belongs to via leadId', async () => {
  const d = await loadDialer();
  try {
    d.evalIn(`
      S.twilio.backendUrl = 'https://backend.test';
      S.done['L-1041'] = {dispo:'appointment', label:'Appointment set', at:'2026-07-29T10:00:00.000Z',
                          direction:'out', talkSeconds:0};
      RECORDINGS = [{ sid:'RE9', duration:120, leadId:'L-1041', leadName:'Dorothy Whitfield',
                      session:null, createdAt:'2026-07-29T10:01:00.000Z' }];
      renderHistory();
    `);
    assert.strictEqual(d.evalIn('callHistory().length'), 1, 'merged into one row, not duplicated');
    assert.strictEqual(d.evalIn('callHistory()[0].sid'), 'RE9', 'recording attached');
    assert.strictEqual(d.evalIn('callHistory()[0].seconds'), 120, 'duration filled in from the recording');
  } finally { d.close(); }
});

/* ---------------- F-7 / manual dials ---------------- */

test('F-7: a manual dial leaves a record and appears in history with its note', async () => {
  const d = await loadDialer({ randomSequence: [0.9] }); // no answer, straight to wrap-up
  try {
    d.$('#manualNumber').value = '+1 813 555 0199';
    d.click('#manualDialBtn');
    await d.wait(3200);

    assert.strictEqual(d.evalIn("MD && MD.phase"), 'wrapup', 'manual dial reached wrap-up');
    d.$('#manualNotes').value = 'Left a message with the daughter';
    d.click('#mdCloseBtn');

    assert.strictEqual(d.evalIn('MANUAL_CALLS.length'), 1, 'the manual dial produced a record');
    assert.strictEqual(d.evalIn('MANUAL_CALLS[0].number'), '+18135550199', 'normalized number stored');
    assert.strictEqual(
      d.evalIn('MANUAL_CALLS[0].note'), 'Left a message with the daughter',
      'the note is PRESERVED — it used to be logged and discarded (F-7)'
    );
    assert.ok(d.$('#historyList').textContent.includes('Left a message with the daughter'),
      'and it is visible in call history');
  } finally { d.close(); }
});

/* ---------------- recording toggle ---------------- */

test('solo recording is on by default and can be switched off for a single call', async () => {
  const d = await loadDialer();
  try {
    assert.strictEqual(d.$('#recordSoloCheck').checked, true, 'owner decision: recording on by default');

    d.evalIn(`
      S.twilio.liveEnabled = true;
      S.twilio.device = { connect: function(o){ window.__params = o.params;
                                                return Promise.resolve({ on:function(){} }); } };
    `);
    d.click('#startBtn');

    d.evalIn('startDial()');
    await d.wait(60);
    assert.strictEqual(d.win.__params.Record, 'true', 'default sends Record=true');

    // Switch it off and dial again.
    d.$('#recordSoloCheck').checked = false;
    d.evalIn(`S.phase='ready'; startDial();`);
    await d.wait(60);
    assert.strictEqual(d.win.__params.Record, 'false', 'unticking sends Record=false');
    assert.ok(d.$('#log').textContent.includes('will NOT be recorded'), 'and it says so out loud');
  } finally { d.close(); }
});

test('the solo toggle cannot switch off power-dial recording', async () => {
  const d = await loadDialer();
  try {
    d.$('#recordSoloCheck').checked = false; // agent has switched solo recording off

    let body = null;
    d.evalIn(`
      S.twilio.liveEnabled = true;
      S.twilio.device = { connect: function(){ return Promise.resolve({ on:function(){} }); } };
    `);
    d.win.fetch = (url, opts) => {
      body = opts && opts.body ? JSON.parse(opts.body) : null;
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ session: 'sess-1', legs: [] })),
      });
    };

    d.selectLeads(['L-1041', 'L-1042']);
    d.click('#powerDialBtn');
    await d.wait(200);

    assert.ok(body, 'power dial reached the backend');
    assert.strictEqual(
      body.Record, undefined,
      'power dial must not send a recording flag at all — server.js sets record-from-start ' +
      'unconditionally on the conference branch, so recording cannot be switched off here'
    );
  } finally { d.close(); }
});
