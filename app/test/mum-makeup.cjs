// Make-up visits (agent to agent): Mum answers Yes to each new visit in the real page; then the script waits until the agreed make-up
// is paid and the claim that does not match the agreement is held by Mina's agent. Shots: mum-makeup.png, mina-a2a.png.
const { chromium } = require('playwright');
const BASE = process.env.CM_BASE || 'http://127.0.0.1:8791', SHOTS = process.env.CM_SHOTS, N = Number(process.env.CM_MAKEUP_N || 2);
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((pk) => localStorage.setItem('caremandate.pagekey', pk), process.env.MUMPK);
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto(BASE + '/mum');
  for (let i = 0; i < N; i++) {
    await p.getByRole('button', { name: 'Yes' }).waitFor({ timeout: 20000 });
    if (i === 0) await p.screenshot({ path: SHOTS + '/mum-makeup.png' });
    await p.getByRole('button', { name: 'Yes' }).click();
    await p.waitForSelector('.done', { timeout: 60000 }); await p.waitForTimeout(2600);
  }
  const until = Date.now() + Number(process.env.CM_SETTLE_WAIT || 120000); let vs = [];
  while (Date.now() < until) {
    vs = await (await fetch(BASE + '/api/visits')).json();
    const mk = vs.slice(5);
    if (mk.length === N && mk.every((v) => (v.status === 'Paid' && v.payment?.markPaidTx) || (v.status === 'Confirmed' && v.review?.decision === 'hold'))) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const m = await ctx.newPage(); await m.goto(BASE + '/mina'); await m.waitForSelector('.a2a', { timeout: 20000 }); await m.waitForTimeout(1500);
  await m.screenshot({ path: SHOTS + '/mina-a2a.png', fullPage: true });
  const got = vs.slice(5).map((v) => [v.id, v.status, v.review?.decision || null, (v.review?.rules || []).join('+')]);
  console.log(JSON.stringify(got));
  const ok = got.length === N && got[0][1] === 'Paid' && got.slice(1).every((g) => g[1] === 'Confirmed' && g[2] === 'hold') && !errs.length;
  console.log(ok ? 'MAKEUP PASS' : 'MAKEUP FAIL', 'page errors', JSON.stringify(errs));
  await b.close();
})();
