'use strict';
(function () {
  var b = document.getElementById('check'); if (!b) return;
  var out = document.getElementById('checkout');
  var RPC = b.dataset.rpc, C = b.dataset.contract, SEL = b.dataset.sel;
  var ST = ['None', 'Posted', 'Confirmed', 'Held', 'Paid', 'Rejected'];
  if (RPC !== 'https://testnet.hsk.xyz' || !/^0x[0-9a-f]{40}$/i.test(C) || !/^0x[0-9a-f]{8}$/.test(SEL)) return;
  b.hidden = false;
  function call(id) {
    var data = SEL + id.toString(16).padStart(64, '0');
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, 15000);
    return fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: C, data: data }, 'latest'] }) })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (s) { if (s.length > 10000) throw new Error('reply too large'); var j = JSON.parse(s);
        if (typeof j.result !== 'string' || !/^0x[0-9a-f]{384}$/i.test(j.result)) throw new Error('unexpected reply'); return j.result.slice(2); });
  }
  b.addEventListener('click', function () {
    var cards = Array.prototype.slice.call(document.querySelectorAll('[data-visit]')).slice(0, 50);
    b.disabled = true; out.textContent = 'Reading ' + cards.length + ' visits from HSK Chain testnet…'; var good = 0, done = 0;
    cards.forEach(function (c) {
      var id = parseInt(c.dataset.visit, 10), el = c.querySelector('.live');
      call(id).then(function (w) {
        var st = ST[parseInt(w.slice(64 * 3, 64 * 4), 16)] || '?', ref = '0x' + w.slice(64 * 5, 64 * 6).toLowerCase();
        var ok = st === c.dataset.status && ref === c.dataset.ref;
        if (ok) good++;
        el.className = 'live small ' + (ok ? 'ok' : 'bad');
        el.textContent = ok ? 'On chain now: ' + st + (st === 'Paid' ? ', payment reference matches this page.' : ', never paid.') : 'On chain now: ' + st + ' (does not match this page).';
      }).catch(function (e) { el.className = 'live small bad'; el.textContent = 'Could not read visit ' + id + ': ' + e.message; })
        .then(function () { if (++done === cards.length) { b.disabled = false; out.textContent = good + ' of ' + cards.length + ' visits match the chain right now.'; } });
    });
  });
})();
