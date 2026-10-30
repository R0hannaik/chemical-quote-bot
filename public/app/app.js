// Dashboard front end. Plain JS, no build step. Every value from the server is escaped before it is shown,
// because messages come from WhatsApp groups and must be treated as untrusted text.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** WhatsApp formatting (*bold*, _italic_, ~strike~) on already-escaped text. */
const wa = (text) => esc(text)
  .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<b>$2</b>')
  .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
  .replace(/(^|[\s(])~([^~\n]+)~/g, '$1<s>$2</s>');
const money = (n) => (n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
const time = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pq-dashboard' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
async function act(fn, done) {
  try { const out = await fn(); if (done) toast(done); return out; } catch (e) { toast(e.message); return undefined; }
}

const state = { me: null, meta: null, status: null, view: 'live', streamFilter: '', groupsQuery: '', groupFilter: 'all',
  templateMode: 'quote_item', drafts: {}, sample: 'npg 10 bags china jiuan pg tech 3 drums china' };
const can = (role) => ({ viewer: 0, operator: 1, owner: 2 })[state.me?.role] >= ({ viewer: 0, operator: 1, owner: 2 })[role];

// ---------------- shell ----------------

const CONN_TEXT = { open: 'WhatsApp linked', qr: 'Waiting for QR scan', connecting: 'Connecting…', disconnected: 'WhatsApp disconnected', logged_out: 'WhatsApp unlinked' };

async function refreshStatus() {
  const s = await api('/status');
  state.status = s;
  $('#conn-dot').className = `dot ${s.whatsapp.state}`;
  $('#conn-text').textContent = CONN_TEXT[s.whatsapp.state] + (s.whatsapp.me ? ` · ${s.whatsapp.me.name || ''}` : '');
  const kill = $('#kill');
  kill.textContent = s.killSwitch ? 'Resume replies' : 'Stop all replies';
  kill.classList.toggle('on', s.killSwitch);
  $('#killbar').classList.toggle('hidden', !s.killSwitch);
  badge('#b-rates', s.counts.stalePrices);
  badge('#b-approvals', s.counts.approvals);
  badge('#b-unmatched', s.counts.unmatched);
  return s;
}
function badge(sel, n) { const b = $(sel); b.textContent = n; b.classList.toggle('hidden', !n); }

$('#kill').addEventListener('click', async () => {
  const on = !state.status?.killSwitch;
  if (on && !confirm('Stop all bot replies now? Queued replies will be cancelled.')) return;
  await act(() => api('/kill-switch', { body: { on } }), on ? 'All replies stopped' : 'Replies resumed');
  await refreshStatus();
  if (state.view === 'live') render();
});
$('#logout').addEventListener('click', async () => { await api('/logout', { body: {} }).catch(() => {}); location.href = '/login'; });

const VIEWS = {};
async function render() {
  const view = VIEWS[state.view] ? state.view : 'live';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  try { await VIEWS[view]($('#main')); } catch (e) { $('#main').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
window.addEventListener('hashchange', () => { state.view = location.hash.slice(1) || 'live'; render(); });

// One click handler for the whole page: elements carry data-action="name".
const ACTIONS = {};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && ACTIONS[el.dataset.change]) ACTIONS[el.dataset.change](el, e);
});

// ---------------- Live ----------------

const OUTCOME_LABEL = { quoted: 'Quoted', booking: 'Booking', held: 'Held', unmatched: 'Unmatched', skipped: 'Duplicate', ignored: 'No reply' };
const REPLY_CHIP = { sent: 'good', scheduled: 'info', sending: 'info', held: 'warn', failed: 'bad', cancelled: '' };

function itemChips(items) {
  return items.map((i) => {
    const bits = [i.productName];
    if (i.quantity) bits.push(`${i.quantity.value} ${i.quantity.unit}`);
    if (i.brand) bits.push(i.brandStocked === false ? `${i.brand} (not stocked)` : i.brand);
    if (i.origin) bits.push(i.origin);
    return `<span class="chip info">${esc(bits.join(' · '))}</span>`;
  }).join('');
}

function exchangeHtml(m) {
  const cls = m.reply_status === 'failed' ? 'failed' : m.outcome || '';
  let reply = '<p class="muted small">No reply sent.</p>';
  if (m.reply_body) {
    const draft = ['held', 'failed', 'cancelled'].includes(m.reply_status);
    reply = `<div class="bubble ${draft ? 'draft' : 'out'}">${wa(m.reply_body)}</div>
      <div class="row small"><span class="chip ${REPLY_CHIP[m.reply_status] || ''}">${esc(m.reply_status)}</span>
        ${m.sent_at ? `<span class="muted">${esc(time(m.sent_at))}</span>` : ''}</div>`;
  }
  const reasons = m.reply_reason || (m.reasons || []).join('; ');
  const actions = can('operator') && m.reply_id && ['held', 'failed', 'cancelled'].includes(m.reply_status)
    ? `<div class="row"><button data-action="resend" data-id="${m.reply_id}">Rebuild and send now</button></div>` : '';
  const cancel = can('operator') && m.reply_id && ['scheduled', 'held'].includes(m.reply_status)
    ? `<button class="link" data-action="cancel-reply" data-id="${m.reply_id}">Cancel</button>` : '';
  return `<article class="exchange ${esc(cls)}">
    <div class="meta"><b>${esc(m.group_name)}</b><span>${esc(time(m.received_at))}</span>
      <span class="chip">${esc(OUTCOME_LABEL[m.outcome] || 'Received')}</span>${cancel}</div>
    <div><div class="bubble in"><span class="who">${esc(m.sender_name || m.sender)}</span>${esc(m.text)}</div>
      <div class="parse">${itemChips(m.items || [])}</div></div>
    <div>${reply}${reasons ? `<div class="reason">${esc(reasons)}</div>` : ''}${actions}</div>
  </article>`;
}

VIEWS.live = async (el) => {
  const s = await refreshStatus();
  const stream = await api(`/stream?limit=60${state.streamFilter ? `&outcome=${state.streamFilter}` : ''}`);
  const wa_ = s.whatsapp;
  let conn = '';
  if (wa_.state === 'qr' && wa_.qr) {
    conn = `<div class="qr"><img src="${esc(wa_.qr)}" alt="WhatsApp link code"></div>
      <div><h2>Link the bot's WhatsApp number</h2>
      <p>On the bot's phone, open WhatsApp, then Settings, Linked devices, Link a device, and scan this code. It refreshes by itself.</p>
      <p class="small muted">Use a number kept only for the bot, not your personal one: WhatsApp can ban numbers it thinks are automated.</p></div>`;
  } else {
    conn = `<div><h2>${esc(CONN_TEXT[wa_.state])}</h2>
      <p class="muted small">${wa_.me ? `Linked as ${esc(wa_.me.name || '')} (${esc((wa_.me.id || '').split(/[:@]/)[0])}) · ` : ''}since ${esc(time(wa_.since))}</p>
      <div class="row">
        ${can('operator') && wa_.state === 'open' ? '<button data-action="sync">Sync groups from WhatsApp</button>' : ''}
        ${can('owner') && wa_.state === 'open' ? '<button class="danger" data-action="unlink">Unlink this number</button>' : ''}
      </div></div>
      <div class="counts">
        <div><b>${s.counts.activeGroups}</b><span class="small muted">groups with auto-reply on</span></div>
        <div><b>${s.counts.groups}</b><span class="small muted">groups synced</span></div>
        <div><b>${s.counts.products}</b><span class="small muted">chemicals</span></div>
        <div><b>${s.delaySeconds}s</b><span class="small muted">reply delay</span></div>
      </div>`;
  }
  const alerts = s.alerts.length ? `<div class="section"><div class="toolbar"><h2>Alerts</h2>
      ${can('operator') ? '<button class="link" data-action="alerts-seen">Mark all read</button>' : ''}</div>
      ${s.alerts.map((a) => `<div class="alert ${esc(a.level)}">${esc(a.text)} <span class="muted small">${esc(ago(a.at))}</span></div>`).join('')}</div>` : '';
  const mock = state.meta.transport === 'mock' && can('operator') ? `<div class="section">
      <h2>Send a test message</h2>
      <p class="small muted">Local testing mode: no real WhatsApp is linked. This goes through the full bot, with the delay, rate limits and checks, into the test group.</p>
      <div class="row"><input id="inject-text" class="grow" value="hi tech pg 20 drums rate?" aria-label="Test message">
      <button class="primary" data-action="inject">Send to test group</button></div></div>` : '';
  const filters = [['', 'All'], ['quoted', 'Quoted'], ['held', 'Held'], ['booking', 'Booking'], ['unmatched', 'Unmatched']]
    .map(([v, l]) => `<button class="${state.streamFilter === v ? 'primary' : ''}" data-action="stream-filter" data-v="${v}">${l}</button>`).join('');
  el.innerHTML = `<div class="section status-panel">${conn}</div>${alerts}${mock}
    <div class="toolbar"><h1>Inquiries and replies</h1>${filters}</div>
    <div class="stream">${stream.length ? stream.map(exchangeHtml).join('') : '<p class="muted">No inquiries yet. Turn on auto-reply for a group, or try the Simulator.</p>'}</div>`;
};

ACTIONS['stream-filter'] = (b) => { state.streamFilter = b.dataset.v; render(); };
ACTIONS.resend = async (b) => { const r = await act(() => api(`/replies/${b.dataset.id}/resend`, { body: {} })); if (r) toast(r.outcome === 'quoted' || r.outcome === 'booking' ? 'Reply rebuilt and queued' : `Still held: ${r.reason}`); render(); };
ACTIONS['cancel-reply'] = async (b) => { await act(() => api(`/replies/${b.dataset.id}/cancel`, { body: {} }), 'Reply cancelled'); render(); };
ACTIONS.sync = async () => { const r = await act(() => api('/wa/sync', { body: {} })); if (r) toast(`${r.count} groups synced`); render(); };
ACTIONS.unlink = async () => { if (confirm('Unlink this WhatsApp number? The bot stops until a number is linked again.')) { await act(() => api('/wa/logout', { body: {} }), 'Unlinked'); render(); } };
ACTIONS['alerts-seen'] = async () => { await act(() => api('/alerts/seen', { body: {} })); render(); };
ACTIONS.inject = async () => {
  const text = $('#inject-text').value.trim();
  if (!text) return;
  await act(() => api('/dev/inject', { body: { text } }), 'Sent to the test group');
  render();
  setTimeout(render, (state.status.delaySeconds + 1.5) * 1000);
};

// ---------------- Rates ----------------

VIEWS.rates = async (el) => {
  const products = await api('/products');
  state.products = products;
  const rows = products.map((p) => {
    const rates = p.rows.length ? p.rows.map((r) => `<div>${esc(r.origin)}${r.brand ? ` · ${esc(r.brand)}` : ''}:
        <b class="price">${money(r.rate)}</b> <span class="muted small">${esc(ago(r.updated_at))}</span>
        ${r.problem ? `<div class="problem">${esc(r.problem)}</div>` : ''}</div>`).join('')
      : '<span class="problem">No price set: inquiries are held</span>';
    const statuses = [...new Set(p.rows.map((r) => r.status))];
    return `<tr class="${p.active ? '' : 'inactive'}">
      <td><b>${esc(p.name)}</b><div class="aliases">${p.aliases.map((a) => `<span class="chip">${esc(a)}</span>`).join('')}</div></td>
      <td>${esc(p.packaging)}<div class="muted small">${esc(p.location)}</div></td>
      <td class="rate">${rates}<div class="muted small">/${esc(p.unit)} + ${esc(p.gst_pct)}% GST</div></td>
      <td>${statuses.map((s) => `<span class="chip ${s === 'In Stock' ? 'good' : s === 'Out of Stock' ? 'bad' : 'warn'}">${esc(s)}</span>`).join(' ')}</td>
      <td>${can('operator') ? `<button data-action="edit-product" data-id="${p.id}">Edit</button>
        <button class="link" data-action="confirm-one" data-id="${p.id}">Confirm price</button>` : ''}</td></tr>`;
  }).join('');
  const stale = state.status?.counts.stalePrices || 0;
  el.innerHTML = `<div class="toolbar"><h1>Chemicals and rates</h1>
      ${can('operator') ? `<button class="primary" data-action="edit-product">Add chemical</button>
      <button data-action="confirm-all">Confirm all prices for today</button>
      <button data-action="import-csv">Import CSV</button>` : ''}
      <a class="btn" href="/api/products.csv">Export CSV</a></div>
    ${stale ? `<p class="alert warn">${stale} price(s) are missing or not confirmed recently. The bot holds quotes for those until they are fixed.</p>` : ''}
    <div class="section table-wrap"><table><thead><tr><th>Chemical and names brokers type</th><th>Packaging</th><th>Rates</th><th>Stock</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
};

ACTIONS['confirm-all'] = async () => {
  if (!confirm('Mark every price as checked today? Only do this after checking the rates are current.')) return;
  const r = await act(() => api('/prices/confirm', { body: {} }));
  if (r) toast(`${r.confirmed} prices confirmed`);
  await refreshStatus(); render();
};
ACTIONS['confirm-one'] = async (b) => { await act(() => api('/prices/confirm', { body: { productIds: [Number(b.dataset.id)] } }), 'Price confirmed'); await refreshStatus(); render(); };

function priceRowHtml(r = {}) {
  const opt = (list, v) => list.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('');
  return `<div class="price-row" data-row-id="${esc(r.id || '')}">
    <select name="origin" aria-label="Origin"><option value="">Origin…</option>${opt(state.meta.origins, r.origin)}</select>
    <input name="brand" placeholder="Brand / maker" value="${esc(r.brand || '')}" aria-label="Brand">
    <input name="rate" type="number" step="0.01" min="0" placeholder="₹ per kg" value="${esc(r.rate ?? '')}" aria-label="Rate">
    <select name="status" aria-label="Stock status">${opt(state.meta.statuses, r.status || 'In Stock')}</select>
    <input name="freshness_hours" type="number" min="1" max="720" value="${esc(r.freshness_hours || 24)}" title="Hours before this price must be confirmed again" aria-label="Freshness hours">
    <button class="link" data-action="remove-row">Remove</button></div>`;
}

ACTIONS['edit-product'] = (b) => {
  const p = b?.dataset.id ? state.products.find((x) => x.id === Number(b.dataset.id)) : null;
  const d = $('#dialog');
  d.innerHTML = `<form method="dialog" id="pform">
    <h2>${p ? `Edit ${esc(p.name)}` : 'Add chemical'}</h2>
    <div class="grid2">
      <label><span>Chemical name</span><input name="name" required value="${esc(p?.name || '')}"></label>
      <label><span>Names brokers type, separated by commas</span><input name="aliases" required value="${esc(p?.aliases.join(', ') || '')}" placeholder="pa, phthalic"></label>
      <label><span>Packaging</span><input name="packaging" value="${esc(p?.packaging || '')}" placeholder="25 kg Bag"></label>
      <label><span>Pack size in kg</span><input name="pack_size_kg" type="number" step="0.01" value="${esc(p?.pack_size_kg ?? '')}"></label>
      <label><span>Location</span><input name="location" value="${esc(p?.location || 'Bhiwandi / Mumbai Ex-Godown')}"></label>
      <label><span>GST %</span><input name="gst_pct" type="number" value="${esc(p?.gst_pct ?? 18)}"></label>
    </div>
    <h3>Prices by origin and brand</h3>
    <p class="small muted">Rate per kg before GST. The last box is how many hours a price stays valid before the bot holds quotes for it.</p>
    <div id="rows">${(p?.rows.length ? p.rows : [{}]).map(priceRowHtml).join('')}</div>
    <button class="link" data-action="add-row">Add origin or brand</button>
    <p class="error hidden" id="perr" role="alert"></p>
    <div class="row">${p ? `<button type="button" class="danger" data-action="toggle-product" data-id="${p.id}" data-active="${p.active ? 0 : 1}">${p.active ? 'Stop quoting this chemical' : 'Quote this chemical again'}</button>` : ''}
      <span class="grow"></span><button type="button" data-action="close-dialog">Cancel</button>
      <button class="primary" type="button" data-action="save-product" data-id="${p?.id || ''}">${p ? 'Save changes' : 'Add chemical'}</button></div>
  </form>`;
  d.showModal();
};
ACTIONS['add-row'] = () => $('#rows').insertAdjacentHTML('beforeend', priceRowHtml());
ACTIONS['remove-row'] = (b) => b.closest('.price-row').remove();
ACTIONS['close-dialog'] = () => $('#dialog').close();
ACTIONS['toggle-product'] = async (b) => { await act(() => api(`/products/${b.dataset.id}/active`, { body: { active: b.dataset.active === '1' } }), 'Saved'); $('#dialog').close(); render(); };
ACTIONS['save-product'] = async (b) => {
  const f = $('#pform');
  const body = {
    name: f.name.value, aliases: f.aliases.value.split(','), packaging: f.packaging.value, pack_size_kg: f.pack_size_kg.value,
    location: f.location.value, gst_pct: f.gst_pct.value,
    rows: [...f.querySelectorAll('.price-row')].map((r) => ({
      id: r.dataset.rowId ? Number(r.dataset.rowId) : undefined, origin: r.querySelector('[name=origin]').value,
      brand: r.querySelector('[name=brand]').value, rate: r.querySelector('[name=rate]').value,
      status: r.querySelector('[name=status]').value, freshness_hours: r.querySelector('[name=freshness_hours]').value,
    })).filter((r) => r.origin || r.rate),
  };
  try {
    await api(b.dataset.id ? `/products/${b.dataset.id}` : '/products', { method: b.dataset.id ? 'PUT' : 'POST', body });
    $('#dialog').close(); toast('Saved'); await refreshStatus(); render();
  } catch (e) { const err = $('#perr'); err.textContent = e.message; err.classList.remove('hidden'); }
};
ACTIONS['import-csv'] = () => {
  const d = $('#dialog');
  d.innerHTML = `<h2>Import rates from CSV</h2>
    <p class="small">Columns: product, aliases (separated by ;), origin, brand, rate, status, freshness_hours, packaging, pack_size_kg, location, gst_pct.
    One line per price. A chemical that already exists has its prices replaced. Export first to get the right layout.</p>
    <input type="file" id="csv-file" accept=".csv,text/csv">
    <p class="error hidden" id="perr"></p>
    <div class="row"><span class="grow"></span><button data-action="close-dialog">Cancel</button><button class="primary" data-action="do-import">Import</button></div>`;
  d.showModal();
};
ACTIONS['do-import'] = async () => {
  const file = $('#csv-file').files[0];
  if (!file) return;
  try {
    const r = await api('/products/import', { body: { csv: await file.text() } });
    $('#dialog').close();
    toast(`${r.created} added, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} skipped` : ''}`);
    if (r.errors.length) alert(r.errors.join('\n'));
    render();
  } catch (e) { const err = $('#perr'); err.textContent = e.message; err.classList.remove('hidden'); }
};

// ---------------- Groups ----------------

VIEWS.groups = async (el) => {
  const groups = await api(`/groups?q=${encodeURIComponent(state.groupsQuery)}`);
  const shown = groups.filter((g) => state.groupFilter === 'all' || (state.groupFilter === 'on' ? g.auto_reply : !g.auto_reply));
  const cats = ['broker', 'internal', 'vip', 'test'];
  const catLabel = { broker: 'Broker market', internal: 'Family / internal', vip: 'Direct buyers (VIP)', test: 'Test' };
  el.innerHTML = `<div class="toolbar"><h1>WhatsApp groups</h1>
      ${can('operator') ? '<button data-action="sync">Sync groups</button><button class="danger" data-action="all-off">Turn all off</button>' : ''}</div>
    <p class="alert">Auto-reply starts off for every group. The bot only answers in groups you switch on here, plus the test group.</p>
    <div class="toolbar"><input id="gq" class="grow" placeholder="Search groups" value="${esc(state.groupsQuery)}" aria-label="Search groups">
      <select id="gf" aria-label="Filter"><option value="all">All groups</option><option value="on" ${state.groupFilter === 'on' ? 'selected' : ''}>Auto-reply on</option>
      <option value="off" ${state.groupFilter === 'off' ? 'selected' : ''}>Auto-reply off</option></select></div>
    <div class="section table-wrap"><table><thead><tr><th>Group</th><th>Type</th><th class="num">Members</th><th class="num">Quotes sent</th><th>Auto-reply</th></tr></thead><tbody>
    ${shown.map((g) => `<tr><td><b>${esc(g.name)}</b>${g.is_test ? ' <span class="chip info">Test group</span>' : ''}
        <div class="muted small">${esc(g.wa_jid)}</div>
        ${can('owner') && !g.is_test ? `<button class="link small" data-action="set-test" data-id="${g.id}">Use as test group</button>` : ''}</td>
      <td><select data-change="group-cat" data-id="${g.id}" ${can('operator') ? '' : 'disabled'} aria-label="Group type">
        ${cats.map((c) => `<option value="${c}" ${g.category === c ? 'selected' : ''}>${catLabel[c]}</option>`).join('')}</select></td>
      <td class="num">${g.members}</td><td class="num">${g.quotes_sent}</td>
      <td><label class="switch" title="Auto-reply"><input type="checkbox" data-change="group-toggle" data-id="${g.id}" ${g.auto_reply ? 'checked' : ''}
        ${can('operator') ? '' : 'disabled'} aria-label="Auto-reply for ${esc(g.name)}"><span></span></label></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No groups yet. Link WhatsApp, then sync groups.</td></tr>'}
    </tbody></table></div>`;
  $('#gq').addEventListener('input', debounce((e) => { state.groupsQuery = e.target.value; render().then(() => { const q = $('#gq'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 300));
  $('#gf').addEventListener('change', (e) => { state.groupFilter = e.target.value; render(); });
};
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
ACTIONS['group-toggle'] = async (el) => {
  if (el.checked && !confirm('Turn on auto-reply in this group? The bot will start quoting prices there.')) { el.checked = false; return; }
  await act(() => api(`/groups/${el.dataset.id}`, { method: 'PUT', body: { auto_reply: el.checked } }), el.checked ? 'Auto-reply on' : 'Auto-reply off');
};
ACTIONS['group-cat'] = (el) => act(() => api(`/groups/${el.dataset.id}`, { method: 'PUT', body: { category: el.value } }), 'Saved');
ACTIONS['all-off'] = async () => { if (confirm('Turn auto-reply off in every group?')) { await act(() => api('/groups/all-off', { body: {} }), 'All groups off'); render(); } };
ACTIONS['set-test'] = async (b) => { await act(() => api(`/groups/${b.dataset.id}/test`, { body: {} }), 'Test group set'); render(); };

// ---------------- Templates ----------------

const MODE_LABEL = {
  quote_header: 'Quote: first line', quote_multi_title: 'Quote: title when several items', quote_item: 'Quote: each item',
  quote_footer: 'Quote: closing lines', booking: 'Booking acknowledgement',
};
const SAMPLES = ['PA kya rate chal raha hai 2 ton ka?', 'Acrylic rate', 'npg 10 bags china jiuan pg tech 3 drums china',
  '10 ton Msg Fufeng first priority rate', 'Bhai booking confirm karo 10 ton PA'];

VIEWS.templates = async (el) => {
  const t = await api('/templates');
  state.templates = t;
  const mode = state.templateMode;
  const body = state.drafts[mode] ?? t[mode];
  el.innerHTML = `<div class="toolbar"><h1>Reply templates</h1><span class="muted small">Version ${t.version}</span></div>
    <div class="two-col">
      <div class="section">
        <label><span>Part of the message</span><select data-change="tmode">${state.meta.templateModes.map((m) =>
          `<option value="${m}" ${m === mode ? 'selected' : ''}>${esc(MODE_LABEL[m] || m)}</option>`).join('')}</select></label>
        <textarea id="tbody" class="template" aria-label="Template text">${esc(body)}</textarea>
        <p class="small muted">Click to insert. A line is left out when its value is empty, so a quote without a quantity has no Requirement line.
          Use *bold* and _italic_ as in WhatsApp.</p>
        <div class="row">${state.meta.templateVariables.map((v) => `<button class="small" data-action="insert-var" data-v="${v}">{${v}}</button>`).join('')}</div>
        <div class="row"><span class="grow"></span>
          <button data-action="t-history">Earlier versions</button>
          ${can('operator') ? '<button class="primary" data-action="t-save">Save template</button>' : ''}</div>
      </div>
      <div><div class="row">${SAMPLES.map((s) => `<button class="small ${s === state.sample ? 'primary' : ''}" data-action="t-sample" data-v="${esc(s)}">${esc(s.slice(0, 28))}</button>`).join('')}</div>
        <div class="phone" id="phone"></div></div>
    </div>`;
  $('#tbody').addEventListener('input', debounce((e) => { state.drafts[mode] = e.target.value; preview(); }, 250));
  preview();
};
async function preview() {
  const r = await api('/templates/preview', { body: { text: state.sample, templates: state.drafts } }).catch((e) => ({ kind: 'none', reasons: [e.message] }));
  $('#phone').innerHTML = `<div class="bubble in"><span class="who">Broker</span>${esc(state.sample)}</div>
    ${r.body ? `<div class="bubble out">${wa(r.body)}</div>` : `<p class="muted">${esc((r.reasons || []).join('; ') || 'No reply')}</p>`}`;
}
ACTIONS['t-sample'] = (b) => { state.sample = b.dataset.v; render(); };
ACTIONS['insert-var'] = (b) => {
  const ta = $('#tbody');
  const v = `{${b.dataset.v}}`;
  ta.setRangeText(v, ta.selectionStart, ta.selectionEnd, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
};
ACTIONS.tmode = (el) => { state.templateMode = el.value; render(); };
ACTIONS['t-save'] = async () => {
  const mode = state.templateMode;
  const r = await act(() => api(`/templates/${mode}`, { method: 'PUT', body: { body: $('#tbody').value } }));
  if (r) { delete state.drafts[mode]; toast(`Saved as version ${r.version}. Live now.`); render(); }
};
ACTIONS['t-history'] = async () => {
  const list = await api(`/templates/${state.templateMode}/history`);
  const d = $('#dialog');
  d.innerHTML = `<h2>Earlier versions: ${esc(MODE_LABEL[state.templateMode])}</h2>
    ${list.map((v) => `<div class="section"><div class="row"><b>Version ${v.version}</b>${v.active ? '<span class="chip good">In use</span>' : ''}
      <span class="muted small">${esc(time(v.created_at))} by ${esc(v.created_by)}</span><span class="grow"></span>
      ${!v.active && can('operator') ? `<button data-action="t-restore" data-id="${v.id}">Restore</button>` : ''}</div>
      <div class="bubble in small">${wa(v.body)}</div></div>`).join('')}
    <div class="row"><span class="grow"></span><button data-action="close-dialog">Close</button></div>`;
  d.showModal();
};
ACTIONS['t-restore'] = async (b) => { await act(() => api(`/templates/restore/${b.dataset.id}`, { body: {} }), 'Restored'); delete state.drafts[state.templateMode]; $('#dialog').close(); render(); };

// ---------------- Approvals ----------------

VIEWS.approvals = async (el) => {
  const list = await api('/approvals');
  const label = { new: 'New', contacted: 'Contacted', won: 'Won', lost: 'Lost' };
  el.innerHTML = `<div class="toolbar"><h1>Bookings and negotiations</h1></div>
    <p class="muted">The bot never confirms a deal. These messages got an acknowledgement; call the buyer to finish.</p>
    <div class="section table-wrap"><table><thead><tr><th>Message</th><th>Product</th><th>Quantity</th><th>Status</th></tr></thead><tbody>
    ${list.map((a) => `<tr><td><b>${esc(a.sender_name || a.sender)}</b> in ${esc(a.group_name)}<div class="bubble in small">${esc(a.text)}</div>
        <span class="muted small">${esc(time(a.received_at))}</span></td>
      <td>${esc(a.product_name || '—')}</td><td>${esc(a.quantity || '—')}</td>
      <td><select data-change="approval" data-id="${a.id}" ${can('operator') ? '' : 'disabled'} aria-label="Status">
        ${Object.entries(label).map(([k, v]) => `<option value="${k}" ${a.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        ${a.assignee ? `<div class="muted small">${esc(a.assignee)}</div>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">No booking requests yet.</td></tr>'}
    </tbody></table></div>`;
};
ACTIONS.approval = async (el) => { await act(() => api(`/approvals/${el.dataset.id}`, { method: 'PUT', body: { status: el.value, assignee: state.me.name } }), 'Updated'); refreshStatus(); };

// ---------------- Unmatched ----------------

VIEWS.unmatched = async (el) => {
  const [list, products] = await Promise.all([api('/unmatched'), api('/products')]);
  const opts = products.filter((p) => p.active).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  el.innerHTML = `<div class="toolbar"><h1>Inquiries the bot did not understand</h1></div>
    <p class="muted">The bot stayed silent on these. Teach it a new name for a chemical so the next one is quoted.</p>
    ${list.map((m) => {
      const nm = m.nearMisses?.[0];
      const suggested = nm ? products.find((p) => p.aliases.some((a) => a.toLowerCase() === nm.suggestion) || p.name.toLowerCase().includes(nm.suggestion)) : null;
      return `<div class="section"><div class="row"><b>${esc(m.group_name)}</b><span class="muted small">${esc(time(m.received_at))}</span></div>
        <div class="bubble in">${esc(m.text)}</div>
        ${can('operator') ? `<div class="row" data-unmatched="${m.id}">
          <input class="grow" name="alias" value="${esc(nm?.word || '')}" placeholder="Word brokers used" aria-label="New name">
          <span>is a name for</span><select name="product" aria-label="Chemical">${opts}</select>
          <button class="primary" data-action="add-alias" data-suggest="${suggested?.id || ''}">Add name</button>
          <button class="link" data-action="dismiss" data-id="${m.id}">Not an inquiry</button></div>` : ''}</div>`;
    }).join('') || '<p class="muted">Nothing here. Every recent inquiry was matched.</p>'}`;
  el.querySelectorAll('[data-action=add-alias]').forEach((b) => { if (b.dataset.suggest) b.parentElement.querySelector('select').value = b.dataset.suggest; });
};
ACTIONS['add-alias'] = async (b) => {
  const row = b.parentElement;
  const r = await act(() => api('/aliases', { body: { productId: Number(row.querySelector('select').value), alias: row.querySelector('input').value } }));
  if (r) { await api(`/unmatched/${row.dataset.unmatched}/dismiss`, { body: {} }); toast('Name added'); refreshStatus(); render(); }
};
ACTIONS.dismiss = async (b) => { await act(() => api(`/unmatched/${b.dataset.id}/dismiss`, { body: {} })); refreshStatus(); render(); };

// ---------------- Simulator ----------------

VIEWS.simulator = async (el) => {
  el.innerHTML = `<div class="toolbar"><h1>Simulator</h1></div>
    <p class="muted">Type any group message to see exactly what the bot would understand and reply. Nothing is sent.</p>
    <div class="two-col"><div class="section">
      <textarea id="sim" rows="3" aria-label="Message">${esc(state.simText || 'benzoic 10 bags pg tech 3 drums china')}</textarea>
      <div class="row">${['PA 2 ton', 'Korea acrylic', 'pta rate pls', 'MELA AND AA RATE PLS', 'acryllic rate?', 'Bhai booking confirm karo 10 ton PA', 'iso tank available']
        .map((s) => `<button class="small" data-action="sim-fill" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <div id="sim-parse"></div></div>
      <div class="phone" id="sim-out"></div></div>`;
  $('#sim').addEventListener('input', debounce(simulate, 250));
  simulate();
};
async function simulate() {
  const text = $('#sim').value;
  state.simText = text;
  const r = await api('/simulate', { body: { text } });
  const p = r.parse, b = r.built;
  const decision = { quote: ['good', 'Would send this quote'], booking: ['good', 'Would acknowledge and add to Approvals'],
    held: ['warn', 'Would hold this reply and alert you'], none: ['', p.confidence === 'low' ? 'Would stay silent and list it under Unmatched' : 'Would not reply'] }[b.kind];
  $('#sim-parse').innerHTML = `<h3>What the bot understood</h3>
    <div class="row"><span class="chip">Intent: ${esc(p.intent)}</span><span class="chip">Confidence: ${esc(p.confidence)}</span>
      <span class="chip ${decision[0]}">${esc(decision[1])}</span></div>
    <div class="parse">${itemChips(p.items) || '<span class="muted small">No chemicals found</span>'}</div>
    ${[...(p.reasons || []), ...(b.reasons || [])].map((x) => `<div class="reason">${esc(x)}</div>`).join('')}`;
  $('#sim-out').innerHTML = `<div class="bubble in"><span class="who">Broker</span>${esc(text)}</div>
    ${b.body ? `<div class="bubble ${b.kind === 'held' ? 'draft' : 'out'}">${wa(b.body)}</div>` : ''}`;
}
ACTIONS['sim-fill'] = (b) => { $('#sim').value = b.dataset.v; simulate(); };

// ---------------- Reports ----------------

VIEWS.reports = async (el) => {
  const r = await api('/reports');
  const max = Math.max(1, ...r.perProduct.map((x) => x.n));
  const bars = (rows, key) => rows.map((x) => `<tr><td>${esc(x[key])}</td><td class="num">${x.n}</td><td class="grow"><div class="bar" data-w="${x.n / max}"></div></td></tr>`).join('');
  const kv = (rows) => rows.map((x) => `<span class="chip">${esc(x.status)}: ${x.n}</span>`).join(' ') || '<span class="muted">None</span>';
  el.innerHTML = `<div class="toolbar"><h1>Last 14 days</h1></div>
    <div class="section counts"><div><b>${r.inquiries}</b><span class="small muted">inquiries</span></div>
      <div><b>${Math.round(r.unmatchedRate * 100)}%</b><span class="small muted">not understood</span></div></div>
    <div class="two-col"><div class="section"><h2>Most asked chemicals</h2><table>${bars(r.perProduct, 'product') || '<tr><td class="muted">No data yet</td></tr>'}</table></div>
      <div class="section"><h2>Quotes sent per group</h2><table>${r.perGroup.map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${g.n}</td></tr>`).join('') || '<tr><td class="muted">No data yet</td></tr>'}</table>
        <h2>Replies</h2><p>${kv(r.replies)}</p><h2>Bookings</h2><p>${kv(r.approvals)}</p></div></div>`;
  el.querySelectorAll('.bar').forEach((b) => { b.style.width = `${Math.round(Number(b.dataset.w) * 100)}%`; });
};

// ---------------- Settings ----------------

VIEWS.settings = async (el) => {
  const s = await api('/settings');
  const owner = can('owner');
  const dis = owner ? '' : 'disabled';
  el.innerHTML = `<div class="toolbar"><h1>Settings</h1></div>
    ${owner ? '' : '<p class="alert">Only the owner can change these settings.</p>'}
    <form class="section" id="sform"><h2>Business details used in replies</h2><div class="grid2">
      <label><span>Business name</span><input name="business_name" value="${esc(s.business_name)}" ${dis}></label>
      <label><span>Person who calls back on bookings</span><input name="contact_name" value="${esc(s.contact_name)}" ${dis}></label>
      <label><span>Phone shown in replies</span><input name="contact_phone" value="${esc(s.contact_phone)}" placeholder="+91 …" ${dis}></label></div>
      <h2>Reply timing</h2><div class="grid2">
      <label><span>Wait before replying (seconds, 0–60)</span><input name="delay_seconds" type="number" min="0" max="60" value="${s.delay_seconds}" ${dis}></label>
      <label><span>Show "typing…" while waiting</span><select name="typing_on" ${dis}><option value="1" ${s.typing_on ? 'selected' : ''}>Yes</option><option value="0" ${s.typing_on ? '' : 'selected'}>No</option></select></label>
      <label><span>Only reply during business hours</span><select name="bh_enabled" ${dis}><option value="1" ${s.business_hours.enabled ? 'selected' : ''}>Yes</option><option value="0" ${s.business_hours.enabled ? '' : 'selected'}>No, reply any time</option></select></label>
      <label><span>Opens (India time)</span><input name="bh_start" type="time" value="${esc(s.business_hours.start)}" ${dis}></label>
      <label><span>Closes</span><input name="bh_end" type="time" value="${esc(s.business_hours.end)}" ${dis}></label></div>
      <h2>Limits</h2><div class="grid2">
      <label><span>Minimum gap between replies in one group (seconds)</span><input name="rl_gap" type="number" value="${s.rate_limits.per_group_seconds}" ${dis}></label>
      <label><span>Most replies per group per hour</span><input name="rl_group" type="number" value="${s.rate_limits.per_group_hour}" ${dis}></label>
      <label><span>Most replies across all groups per hour</span><input name="rl_all" type="number" value="${s.rate_limits.global_hour}" ${dis}></label>
      <label><span>Ignore a repeated question for (minutes)</span><input name="dup" type="number" value="${s.duplicate_window_minutes}" ${dis}></label></div>
      <label><span>Brands brokers may ask for, one per line (used to say "not available" for brands you don't stock)</span>
        <textarea name="brands" rows="4" ${dis}>${esc(s.known_brands.join('\n'))}</textarea></label>
      ${owner ? '<button class="primary" data-action="save-settings">Save settings</button>' : ''}</form>
    <div class="section"><h2>Your password</h2><div class="row"><input type="password" id="newpw" class="grow" placeholder="New password, at least 10 characters" autocomplete="new-password" aria-label="New password">
      <button data-action="change-pw">Change password</button></div><p class="small muted">Changing it signs you out on every device.</p></div>
    <div id="owner-extra"></div>`;
  if (owner) {
    const [users, log] = await Promise.all([api('/users'), api('/audit')]);
    $('#owner-extra').innerHTML = `<div class="section"><h2>People with access</h2><table>
      ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td>
        <td>${u.id !== state.me.id ? `<button class="link" data-action="del-user" data-id="${u.id}">Remove</button>` : ''}</td></tr>`).join('')}</table>
      <h3>Add a person</h3><div class="grid2" id="ufields"><input name="name" placeholder="Name" aria-label="Name"><input name="email" type="email" placeholder="Email" aria-label="Email">
        <select name="role" aria-label="Role"><option value="operator">Operator: rates, groups, approvals</option><option value="viewer">Viewer: look only</option><option value="owner">Owner: everything</option></select>
        <input name="password" type="password" placeholder="Starting password (10+ characters)" autocomplete="new-password" aria-label="Password"></div>
      <button data-action="add-user">Add person</button></div>
      <div class="section table-wrap"><h2>Change history</h2><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
      ${log.map((a) => `<tr><td class="small">${esc(time(a.at))}</td><td>${esc(a.user_name)}</td><td>${esc(a.action)} <span class="muted small">${esc(a.entity)}</span></td></tr>`).join('')}
      </tbody></table></div>`;
  }
};
ACTIONS['save-settings'] = async () => {
  const f = $('#sform');
  const body = {
    business_name: f.business_name.value, contact_name: f.contact_name.value, contact_phone: f.contact_phone.value,
    delay_seconds: Number(f.delay_seconds.value), typing_on: f.typing_on.value === '1',
    business_hours: { enabled: f.bh_enabled.value === '1', start: f.bh_start.value, end: f.bh_end.value },
    rate_limits: { per_group_seconds: f.rl_gap.value, per_group_hour: f.rl_group.value, global_hour: f.rl_all.value },
    duplicate_window_minutes: f.dup.value, known_brands: f.brands.value.split('\n'),
  };
  await act(() => api('/settings', { method: 'PUT', body }), 'Settings saved');
  refreshStatus();
};
ACTIONS['change-pw'] = async () => {
  const r = await act(() => api('/me/password', { body: { password: $('#newpw').value } }));
  if (r) location.href = '/login';
};
ACTIONS['add-user'] = async () => {
  const q = (n) => $(`#ufields [name=${n}]`).value;
  await act(() => api('/users', { body: { name: q('name'), email: q('email'), role: q('role'), password: q('password') } }), 'Person added');
  render();
};
ACTIONS['del-user'] = async (b) => { if (confirm('Remove this person\'s access?')) { await act(() => api(`/users/${b.dataset.id}`, { method: 'DELETE' }), 'Removed'); render(); } };

// ---------------- start ----------------

(async () => {
  [state.me, state.meta] = await Promise.all([api('/me'), api('/meta')]);
  $('#who').textContent = `${state.me.name} (${state.me.role})`;
  if (!can('operator')) $('#kill').classList.add('hidden');
  const s = await refreshStatus();
  void s;
  state.view = location.hash.slice(1) || 'live';
  render();
  // Keep the live view and the QR code current.
  setInterval(async () => {
    if (document.hidden || $('#dialog').open) return;
    const a = document.activeElement;
    if (a && $('#main').contains(a) && a.matches('input, textarea, select')) return;
    if (state.view === 'live') render(); else refreshStatus().catch(() => {});
  }, 5000);
})();
