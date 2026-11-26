'use strict';
(function () {
  var b = document.getElementById('mcheck'); if (!b) return;
  var out = document.getElementById('mcheckout'), d = b.dataset;
  var ST = ['None', 'Posted', 'Confirmed', 'Held', 'Paid', 'Rejected'];
  if (d.rpc !== 'https://mainnet.hsk.xyz' || !/^0x[0-9a-f]{40}$/i.test(d.contract) || !/^[0-9]{1,6}$/.test(d.mvisit) || !/^0x[0-9a-f]{8}$/.test(d.selVisits) || !/^0x[0-9a-f]{8}$/.test(d.selPayments)) return;
  b.hidden = false;
  function rpc(method, params, words) {
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, 15000);
    return fetch(d.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (s) { if (s.length > 10000) throw new Error('reply too large'); var j = JSON.parse(s);
        var re = words ? new RegExp('^0x[0-9a-f]{' + (64 * words) + '}$', 'i') : /^0x[0-9a-f]{1,16}$/i;
        if (typeof j.result !== 'string' || !re.test(j.result)) throw new Error('unexpected reply'); return j.result.slice(2).toLowerCase(); });
  }
  function call(sel, words) { return rpc('eth_call', [{ to: d.contract, data: sel + parseInt(d.mvisit, 10).toString(16).padStart(64, '0') }, 'latest'], words); }
  function line(ok, label, page, chain) { var li = document.createElement('li'); li.className = ok ? 'ok' : 'bad';
    li.textContent = (ok ? 'match: ' : 'MISMATCH: ') + label + (ok ? ' = ' + chain : ' (page ' + page + ', chain ' + chain + ')'); out.appendChild(li); return ok; }
  b.addEventListener('click', function () {
    b.disabled = true; out.textContent = ''; var t0 = Date.now();
    var li = document.createElement('li'); li.textContent = 'Reading visit ' + d.mvisit + ' from HSK Chain mainnet…'; out.appendChild(li);
    Promise.all([rpc('eth_chainId', [], 0), call(d.selVisits, 6), call(d.selPayments, 4)]).then(function (r) {
      out.textContent = ''; var n = 0, w = r[1], p = r[2];
      n += line(r[0] === 'b1', 'chain id', '177', String(parseInt(r[0], 16)));
      n += line(ST[parseInt(w.slice(64 * 3, 64 * 4), 16)] === d.status, 'status', d.status, ST[parseInt(w.slice(64 * 3, 64 * 4), 16)] || '?');
      var ref = '0x' + w.slice(64 * 5, 64 * 6); n += line(ref === d.ref, 'paymentRef (keccak256 of the HSP flow id)', d.ref.slice(0, 12) + '…', ref.slice(0, 12) + '…');
      var paid = BigInt('0x' + p.slice(0, 64)).toString(); n += line(paid === d.paid, 'paid (USDC units)', d.paid, paid);
      var stx = '0x' + p.slice(64, 128); n += line(stx === d.stx, 'settlement tx', d.stx.slice(0, 12) + '…', stx.slice(0, 12) + '…');
      var ack = parseInt(p.slice(192, 256), 16) === 1; n += line(String(ack) === d.ack, 'agency acknowledged', 'yes', ack ? 'yes' : 'no');
      var s = document.createElement('li'); s.className = n === 6 ? 'ok' : 'bad';
      s.innerHTML = '<b>' + (n === 6 ? 'All 6 match' : (6 - n) + ' of 6 do not match') + '</b> (HSK Chain mainnet, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s).'; out.appendChild(s);
    }).catch(function (e) { out.textContent = ''; line(false, 'read', 'visit ' + d.mvisit, e.message); })
      .then(function () { b.disabled = false; });
  });
})();
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
