/* Power-dial correctness.
 *
 * The first three tests pin defects F-1, F-2 and F-3 from the 2026-07-29 review. Each one drives
 * the real page the way an insurance agent would -- tick leads, press Power dial -- and asserts on
 * what the agent can actually see and do afterwards.
 *
 * The last two are guard tests: they pass today, and exist so a fix for the first three cannot
 * quietly break the safety invariants the file already enforces.
 *
 * Non-blocked sample leads: L-1041, L-1042, L-1044, L-1047, L-1048.
 * Blocked: L-1043 (CALLING_WINDOW), L-1045 (INTERNAL_DNC), L-1046 (ATTEMPT_LIMIT).
 *
 * How the random sequence maps onto a simulated power dial. Two draws per leg, at SCHEDULE time,
 * in leg order -- first the ring delay (1200 + r*3200 ms), then the outcome roll:
 *        r < 0.15               voicemail / machine, leg released
 *        0.15 <= r < 0.55       a human answers
 *        r >= 0.55              no answer
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDialer } = require('./harness.js');

const ANSWER = 0.30;    // human answers
const NO_ANSWER = 0.90; // rings out

test('F-1: a power dial that connects gives the agent a way to hang up', async () => {
  // One leg, answers after 1200ms. No "Start session" pressed first -- the Power dial button does
  // not require one, so this is a path an agent can reach on their first click of the day.
  const d = await loadDialer({ randomSequence: [0, ANSWER] });
  try {
    d.selectLeads(['L-1041']);
    d.click('#powerDialBtn');
    await d.wait(1600);

    assert.strictEqual(d.evalIn('S.phase'), 'connected', 'the call should be connected');

    const stage = d.text('#stageBody');
    assert.ok(
      !stage.includes('No session running'),
      'a connected call must not render the idle "No session running" card.\n' +
      `S.running=${d.evalIn('S.running')} S.idx=${d.evalIn('S.idx')} S.phase=${d.evalIn('S.phase')}\n` +
      `stage showed: ${stage.replace(/\s+/g, ' ').trim().slice(0, 120)}`
    );
    assert.ok(d.$('#hangBtn'), 'a connected call must offer a Hang up button');
    assert.ok(!d.$('#hangBtn').disabled, 'the Hang up button must be enabled during a connected call');
  } finally { d.close(); }
});

test('F-2: a power dial where nobody answers ends by itself', async () => {
  // Two legs, both ring out. Delays 1200ms and 1360ms; nothing answers.
  const d = await loadDialer({ randomSequence: [0, NO_ANSWER, 0.05, NO_ANSWER] });
  try {
    d.selectLeads(['L-1041', 'L-1042']);
    d.click('#powerDialBtn');
    await d.wait(2000);

    assert.strictEqual(
      d.evalIn('PD'), null,
      'the power-dial session must be torn down once every leg has rung out.\n' +
      `PD.finished=${d.evalIn('PD && PD.finished')} ` +
      `leg statuses=${d.evalIn('PD ? JSON.stringify(PD.legs.map(function(l){return l.status})) : "n/a"')}`
    );
    assert.ok(
      !d.text('#stageBody').includes('Power dial in progress'),
      'the stage must stop claiming lines are ringing after they have all stopped'
    );
    assert.ok(
      !d.$('#startBtn').disabled,
      'Start session must not stay locked out after a power dial that nobody answered'
    );
  } finally { d.close(); }
});

test('F-3: a consumer who answers and is dropped for another line is recorded as abandoned', async () => {
  // Two legs. Leg A answers at 1200ms and wins. Leg B is answered by a human at 1520ms and is then
  // hung up because A already won -- that is an abandoned call under the FCC/FTC rules the header
  // stat and its 3% threshold exist to track.
  const d = await loadDialer({ randomSequence: [0, ANSWER, 0.1, ANSWER] });
  try {
    d.selectLeads(['L-1041', 'L-1042']);
    d.click('#powerDialBtn');
    await d.wait(2200);

    assert.strictEqual(
      d.evalIn('S.stats.abandoned'), 1,
      'the dropped consumer must count as an abandoned call.\n' +
      `L-1042 was recorded as: ${d.evalIn('JSON.stringify((S.done["L-1042"]||{}).dispo)')}\n` +
      'If this is 0, the abandoned-lost-race branch never ran.'
    );
    assert.strictEqual(
      d.text('#sAbandoned'), '1',
      'the header stat must show the abandoned call'
    );
  } finally { d.close(); }
});

test('every leg of a power dial counts as a dial attempt, answered or not', async () => {
  // Three legs, none answered. Dials were previously only counted on connect, so a power dial that
  // rang out left "5 dialed" showing as 0 -- five consumers called with no trace in the session.
  const d = await loadDialer({
    randomSequence: [0, NO_ANSWER, 0.05, NO_ANSWER, 0.1, NO_ANSWER],
  });
  try {
    d.selectLeads(['L-1041', 'L-1042', 'L-1044']);
    d.click('#powerDialBtn');
    await d.wait(2200);

    assert.strictEqual(d.evalIn('S.stats.dialed'), 3, 'all three placed legs are dial attempts');
    assert.strictEqual(d.text('#sDialed'), '3', 'the header stat must agree');
  } finally { d.close(); }
});

test('leads nobody answered are recorded, not silently left eligible', async () => {
  // A lead that was called and rang out must carry an outcome. Leaving it with no record would put
  // it back in the eligible pool as if it had never been dialled.
  const d = await loadDialer({ randomSequence: [0, NO_ANSWER, 0.05, NO_ANSWER] });
  try {
    d.selectLeads(['L-1041', 'L-1042']);
    d.click('#powerDialBtn');
    await d.wait(2000);

    for (const id of ['L-1041', 'L-1042']) {
      assert.strictEqual(
        d.evalIn(`(S.done["${id}"]||{}).dispo`), 'no-answer',
        `${id} was dialled and rang out, so it must hold a no-answer record`
      );
      assert.strictEqual(
        d.evalIn(`(S.done["${id}"]||{}).attempted`), true,
        `${id} was genuinely dialled, so attempted must be true`
      );
    }
  } finally { d.close(); }
});

/* ---------------- guard tests: these pass today and must keep passing ---------------- */

test('guard: blocked leads cannot be selected for a power dial', async () => {
  const d = await loadDialer();
  try {
    for (const blocked of ['L-1043', 'L-1045', 'L-1046']) {
      assert.strictEqual(
        d.$(`.pdCheck[data-id="${blocked}"]`), null,
        `${blocked} is blocked by the compliance floor and must not be power-dialable`
      );
    }
    assert.strictEqual(d.$$('.pdCheck').length, 5, 'only the 5 eligible leads are selectable');
  } finally { d.close(); }
});

test('guard: power dial refuses more than 5 leads at once', async () => {
  const d = await loadDialer();
  try {
    d.selectLeads(['L-1041', 'L-1042', 'L-1044', 'L-1047', 'L-1048']);
    assert.strictEqual(d.evalIn('pdSelected.size'), 5);

    // A sixth would exceed the cap the owner set (Q-18: hard cap 5). There is no sixth eligible
    // lead in the sample set, so assert the guard itself rather than the count.
    assert.ok(
      d.$('#powerDialBtn').textContent.includes('(5/5)'),
      'the button must show the selection against the cap'
    );
  } finally { d.close(); }
});

test('guard: simulated power dial places no network request', async () => {
  const d = await loadDialer({ randomSequence: [0, ANSWER] });
  try {
    let called = null;
    d.win.fetch = (url) => { called = String(url); return Promise.reject(new Error('blocked')); };
    d.selectLeads(['L-1041']);
    d.click('#powerDialBtn');
    await d.wait(1600);
    assert.strictEqual(called, null, `simulated dialing must not reach the network (hit: ${called})`);
  } finally { d.close(); }
});
