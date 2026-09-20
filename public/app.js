/* 检索工作台前端逻辑：查询提交、结果渲染、分页、评分分布、过滤联动 */
const $ = (sel) => document.querySelector(sel);

const state = { page: 1, pageSize: 10 };

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function buildQuery() {
  const p = new URLSearchParams();
  p.set('q', $('#q').value.trim());
  p.set('page', state.page);
  p.set('pageSize', $('#fPageSize').value);
  if ($('#fType').value) p.set('type', $('#fType').value);
  if ($('#fFrom').value) p.set('from', $('#fFrom').value);
  if ($('#fTo').value) p.set('to', $('#fTo').value);
  if ($('#fSource').value.trim()) p.set('source', $('#fSource').value.trim());
  p.set('explain', '1');
  return p.toString();
}

async function doSearch() {
  const meta = $('#meta');
  meta.textContent = '检索中…';
  try {
    const data = await api('/api/search?' + buildQuery());
    renderMeta(data);
    renderDist(data);
    renderResults(data);
    renderPager(data);
  } catch (err) {
    meta.textContent = '检索失败：' + err.message;
  }
}

function renderMeta(d) {
  $('#meta').innerHTML =
    `共 <b>${d.total}</b> 条结果 · 用时 <b>${d.tookMs} ms</b>` +
    (d.cached ? ' · <span class="tag">缓存命中</span>' : '') +
    (d.queryTerms.length ? ` · 查询词项：${d.queryTerms.map((t) => `<code>${esc(t)}</code>`).join(' ')}` : '');
}

function renderDist(d) {
  const el = $('#dist');
  if (!d.scoreDist || !d.scoreDist.length || d.total === 0) { el.innerHTML = ''; return; }
  const max = Math.max(...d.scoreDist);
  el.innerHTML = '<span class="dist-label">评分分布</span>' + d.scoreDist.map((n) =>
    `<span class="bar" style="height:${Math.max(3, (n / max) * 28)}px" title="${n} 篇"></span>`
  ).join('');
}

function renderResults(d) {
  const el = $('#results');
  if (!d.items.length) {
    el.innerHTML = '<div class="empty">无匹配结果，试试调整关键词或过滤条件</div>';
    return;
  }
  const maxScore = Math.max(...d.items.map((i) => i.score), 0.0001);
  el.innerHTML = d.items.map((item) => `
    <article class="result">
      <div class="r-head">
        <a class="r-title" href="/api/documents/${item.id}" target="_blank">${esc(item.title) || '(无标题)'}</a>
        <span class="tag">${esc(item.docType)}</span>
        ${item.source ? `<span class="tag src">${esc(item.source)}</span>` : ''}
        <span class="r-date">${esc(item.createdAt)}</span>
      </div>
      <div class="r-snippet">${item.snippet || ''}</div>
      <div class="r-score">
        <span class="score-bar"><span style="width:${(item.score / maxScore) * 100}%"></span></span>
        <span class="score-num">${item.score}</span>
        ${item.explain ? `<details class="explain"><summary>评分构成</summary><pre>${esc(JSON.stringify(item.explain, null, 2))}</pre></details>` : ''}
      </div>
    </article>`).join('');
}

function renderPager(d) {
  const el = $('#pager');
  if (d.pages <= 1) { el.innerHTML = ''; return; }
  let html = `<button ${d.page <= 1 ? 'disabled' : ''} data-p="${d.page - 1}">上一页</button>`;
  const win = 2;
  for (let p = 1; p <= d.pages; p++) {
    if (p === 1 || p === d.pages || Math.abs(p - d.page) <= win) {
      html += `<button class="${p === d.page ? 'cur' : ''}" data-p="${p}">${p}</button>`;
    } else if (Math.abs(p - d.page) === win + 1) {
      html += '<span>…</span>';
    }
  }
  html += `<button ${d.page >= d.pages ? 'disabled' : ''} data-p="${d.page + 1}">下一页</button>`;
  el.innerHTML = html;
  el.querySelectorAll('button[data-p]').forEach((b) =>
    b.addEventListener('click', () => { state.page = Number(b.dataset.p); doSearch(); }));
}

async function loadTypes() {
  const stats = await api('/api/stats');
  const sel = $('#fType');
  for (const t of stats.docTypes) {
    const opt = document.createElement('option');
    opt.value = t.type;
    opt.textContent = `${t.type} (${t.count})`;
    sel.appendChild(opt);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('#searchBtn').addEventListener('click', () => { state.page = 1; doSearch(); });
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.page = 1; doSearch(); } });
for (const id of ['#fType', '#fFrom', '#fTo', '#fPageSize']) {
  $(id).addEventListener('change', () => { state.page = 1; doSearch(); });
}
$('#fSource').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.page = 1; doSearch(); } });

loadTypes().then(doSearch);
