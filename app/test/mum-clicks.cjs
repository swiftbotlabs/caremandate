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
  }
  await p.screenshot({ path: SHOTS + '/mum-done.png' });
  const m = await ctx.newPage(); await m.goto('' + BASE + '/mina'); await m.waitForSelector('.approve', { timeout: 20000 });
  await m.screenshot({ path: SHOTS + '/mina-held.png', fullPage: true });
  await m.click('.approve'); await m.waitForTimeout(Number(process.env.CM_APPROVE_WAIT || 5000)); await m.reload(); await m.waitForTimeout(1500);
  await m.screenshot({ path: SHOTS + '/mina-after.png', fullPage: true });
  const vs = await (await fetch('' + BASE + '/api/visits')).json();
  console.log(JSON.stringify(vs.map((v) => [v.id, v.status, v.payment ? v.payment.mode : null])));
  const want = ['Paid', 'Rejected', 'Paid', 'Paid', 'Paid'];
  const got = vs.map((v) => v.status);
  console.log(JSON.stringify(got) === JSON.stringify(want) ? 'E2E PASS' : 'E2E FAIL ' + JSON.stringify(got), 'page errors', JSON.stringify(errs));
  await b.close();
})();
