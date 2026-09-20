'use strict';

const state = { page: 1, maxScore: 0 };
const $ = (id) => document.getElementById(id);

async function loadTypes() {
  const res = await fetch('/api/stats');
  const stats = await res.json();
  const select = $('typeFilter');
  for (const t of stats.types) {
    const opt = document.createElement('option');
    opt.value = t.type;
    opt.textContent = `${t.type} (${t.count})`;
    select.appendChild(opt);
  }
}

async function doSearch(page = 1) {
  state.page = page;
  const params = new URLSearchParams({
    q: $('q').value,
    page,
    pageSize: $('pageSize').value,
  });
  if ($('typeFilter').value) params.set('type', $('typeFilter').value);
  if ($('fromFilter').value) params.set('from', $('fromFilter').value);
  if ($('toFilter').value) params.set('to', $('toFilter').value);

  const res = await fetch('/api/search?' + params);
  const data = await res.json();
  renderMeta(data);
  renderFacets(data);
  renderResults(data);
  renderPagination(data);
}

function renderMeta(data) {
  $('meta').textContent =
    `共 ${data.total} 条结果，第 ${data.page}/${data.totalPages} 页，` +
    `耗时 ${data.tookMs} ms${data.cached ? '（缓存命中）' : ''}`;
}

function renderFacets(data) {
  const box = $('facets');
  box.innerHTML = '';
  const current = $('typeFilter').value;
  for (const f of data.facets.types) {
    const el = document.createElement('span');
    el.className = 'facet' + (f.type === current ? ' active' : '');
    el.textContent = `${f.type} ${f.count}`;
    el.onclick = () => {
      $('typeFilter').value = f.type === current ? '' : f.type;
      doSearch(1);
    };
    box.appendChild(el);
  }
}

function renderResults(data) {
  const box = $('results');
  box.innerHTML = '';
  if (!data.results.length) {
    box.innerHTML = '<p class="meta">无匹配结果</p>';
    return;
  }
  const maxScore = Math.max(...data.results.map((r) => r.score), 0.0001);
  for (const r of data.results) {
    const el = document.createElement('div');
    el.className = 'result';
    el.innerHTML = `
      <h3>${r.title}</h3>
      <p class="snippet">${r.snippet}</p>
      <div class="info">
        <span>#${r.id}</span><span>${r.type}</span>
        <span>${r.author || '佚名'}</span>
        <span>${(r.created_at || '').slice(0, 10)}</span>
        <span>得分 ${r.score}</span>
        <span class="score-bar"><div style="width:${Math.round((r.score / maxScore) * 100)}%"></div></span>
      </div>`;
    box.appendChild(el);
  }
}

function renderPagination(data) {
  const box = $('pagination');
  box.innerHTML = '';
  const { page, totalPages } = data;
  const add = (label, target, opts = {}) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (opts.current) btn.className = 'current';
    if (opts.disabled) btn.disabled = true;
    btn.onclick = () => doSearch(target);
    box.appendChild(btn);
  };
  add('上一页', page - 1, { disabled: page <= 1 });
  const windowSize = 2;
  for (let p = Math.max(1, page - windowSize); p <= Math.min(totalPages, page + windowSize); p++) {
    add(p, p, { current: p === page });
  }
  add('下一页', page + 1, { disabled: page >= totalPages });
}

$('searchBtn').onclick = () => doSearch(1);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(1); });
for (const id of ['typeFilter', 'fromFilter', 'toFilter', 'pageSize']) {
  $(id).addEventListener('change', () => doSearch(1));
}

loadTypes();
doSearch(1);
