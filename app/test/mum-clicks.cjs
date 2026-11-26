// Mum answers in the real page (her key set in the tablet's storage, as after setup); then Mina approves the held visit.
const { chromium } = require('playwright');
const BASE = process.env.CM_BASE || 'http://127.0.0.1:8791';
const SHOTS = process.env.CM_SHOTS || require('path').join(__dirname, '..', '..', 'shots'), TMO = Number(process.env.CM_CLICK_TIMEOUT || 30000);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((pk) => localStorage.setItem('caremandate.pagekey', pk), process.env.MUMPK);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto('' + BASE + '/mum');
  for (const [i, ans] of [[1, 'Yes'], [2, 'No'], [3, 'Yes'], [4, 'Yes'], [5, 'Yes']]) {
    await p.getByRole('button', { name: ans }).waitFor({ timeout: 20000 });
    if (i === 1) await p.screenshot({ path: SHOTS + '/mum-question.png' });
    await p.getByRole('button', { name: ans }).click();
    await p.waitForSelector('.done', { timeout: TMO });
    if (i === 1) { await p.waitForSelector('.pay-wait, .pay-ok, .pay-warn', { timeout: 20000 }); await p.screenshot({ path: SHOTS + '/mum-paying.png' }); }
    await p.waitForTimeout(2600);   // the page shows the next question 2.5 s after an answer
  }
  const m = await ctx.newPage(); await m.goto('' + BASE + '/mina'); await m.waitForSelector('.approve', { timeout: 20000 });
  await m.screenshot({ path: SHOTS + '/mina-held.png', fullPage: true });
  await m.click('.approve');
  // payments run in the background (a real HSP payment takes ~3 min each, one at a time): wait until none is in flight
  const want = ['Paid', 'Rejected', 'Paid', 'Paid', 'Paid'], until = Date.now() + Number(process.env.CM_SETTLE_WAIT || 60000);
  let vs = [], last = '';
  while (Date.now() < until) {
    vs = await (await fetch('' + BASE + '/api/visits')).json();
    const now = JSON.stringify(vs.map((v) => [v.status, v.payment && (v.payment.hspStatus || v.payment.status)]));
    if (now !== last) { console.log(new Date().toISOString(), now); last = now; }
    // the agent held a visit after reading its note: Mina reads why, then presses "Pay anyway" (CM_NO_RELEASE=1 leaves it held)
    const held = vs.find((v) => v.status === 'Confirmed' && v.review?.decision === 'hold' && !v.review.released && !v.payment);
    if (held && !process.env.CM_NO_RELEASE) {
      await m.reload(); await m.waitForSelector('.release', { timeout: 20000 });
      await m.screenshot({ path: SHOTS + '/mina-review-held.png', fullPage: true });
      await m.click('.release'); console.log(new Date().toISOString(), 'mina released visit', held.id, 'after reading:', JSON.stringify(held.review.reasons));
      await new Promise((r) => setTimeout(r, 1500)); continue;
    }
    if (vs.every((v) => v.status !== 'Confirmed' && v.status !== 'Held' && (v.status !== 'Paid' || v.payment?.markPaidTx)) || vs.some((v) => ['failed', 'unsettled'].includes(v.payment?.status))) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await p.screenshot({ path: SHOTS + '/mum-done.png' });
  await m.reload(); await m.waitForTimeout(1500);
  await m.screenshot({ path: SHOTS + '/mina-after.png', fullPage: true });
  console.log(JSON.stringify(vs.map((v) => [v.id, v.status, v.payment ? v.payment.mode : null])));
  const got = vs.map((v) => v.status);
  console.log(JSON.stringify(got) === JSON.stringify(want) ? 'E2E PASS' : 'E2E FAIL ' + JSON.stringify(got), 'page errors', JSON.stringify(errs));
  await b.close();
})();
