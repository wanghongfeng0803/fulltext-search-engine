'use strict';

const $ = (id) => document.getElementById(id);
let docPage = 1;

async function loadStats() {
  const stats = await (await fetch('/api/stats')).json();
  $('stats').innerHTML = [
    ['文档总数', stats.documents],
    ['不同词项', stats.distinctTerms],
    ['倒排记录', stats.postings],
    ['平均文档词数', stats.avgDocLength],
    ['索引代次', stats.generation],
  ].map(([label, num]) =>
    `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`
  ).join('');
}

async function loadDocs(page = 1) {
  docPage = page;
  const data = await (await fetch(`/api/documents?page=${page}&pageSize=15`)).json();
  const tbody = $('docTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const d of data.results) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${d.id}</td><td></td><td>${d.type}</td><td>${d.author || '-'}</td>
      <td>${d.doc_len}</td><td>${(d.created_at || '').slice(0, 19).replace('T', ' ')}</td>
      <td><button class="del-btn">删除</button></td>`;
    tr.children[1].textContent = d.title;
    tr.querySelector('.del-btn').onclick = async () => {
      if (!confirm(`确认删除文档 #${d.id}？`)) return;
      await fetch(`/api/documents/${d.id}`, { method: 'DELETE' });
      loadStats();
      loadDocs(docPage);
    };
    tbody.appendChild(tr);
  }
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pager = $('docPager');
  pager.innerHTML = '';
  const mk = (label, target, disabled) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = disabled;
    b.onclick = () => loadDocs(target);
    pager.appendChild(b);
  };
  mk('上一页', docPage - 1, docPage <= 1);
  mk('下一页', docPage + 1, docPage >= totalPages);
}

$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    title: form.title.value,
    content: form.content.value,
    type: form.type.value,
    author: form.author.value,
    tags: form.tags.value,
  };
  const res = await fetch('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  $('addMsg').textContent = res.ok ? `已入库，文档 ID = ${data.id}` : `失败：${data.error}`;
  if (res.ok) {
    form.reset();
    form.type.value = 'article';
    loadStats();
    loadDocs(1);
  }
};

$('reindexBtn').onclick = async () => {
  $('reindexMsg').textContent = '重建中…';
  const res = await fetch('/api/admin/reindex', { method: 'POST' });
  const data = await res.json();
  $('reindexMsg').textContent = `完成：${data.reindexed} 篇文档，耗时 ${data.tookMs} ms`;
  loadStats();
};

loadStats();
loadDocs();
