/* 索引管理后台前端逻辑：统计面板、文档 CRUD、批量导入、索引维护 */
const $ = (sel) => document.querySelector(sel);
let docPage = 1;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadStats() {
  const s = await api('/api/stats');
  $('#statCards').innerHTML = [
    ['文档数', s.documents], ['词项数', s.terms], ['倒排记录', s.postings],
    ['平均标题长', s.avgTitleLen], ['平均正文长', s.avgContentLen],
    ['DB 体积', (s.dbSizeBytes / 1024).toFixed(1) + ' KB'],
    ['查询缓存', `${s.cache.size}/${s.cache.max}`],
  ].map(([k, v]) => `<div class="card"><div class="card-num">${v}</div><div class="card-label">${k}</div></div>`).join('');

  $('#topTerms tbody').innerHTML = s.topTerms.map((t) =>
    `<tr><td>${esc(t.term)}</td><td>${t.df}</td><td>${t.tf}</td></tr>`).join('');
}

async function loadDocs() {
  const d = await api(`/api/documents?page=${docPage}&pageSize=15`);
  $('#docTable tbody').innerHTML = d.items.map((doc) => `
    <tr>
      <td>${doc.id}</td><td class="t-title">${esc(doc.title)}</td>
      <td>${esc(doc.doc_type)}</td><td>${esc(doc.source)}</td>
      <td>${doc.contentLen}</td><td>${esc(doc.created_at)}</td>
      <td><button class="del" data-id="${doc.id}">删除</button></td>
    </tr>`).join('');
  const pages = Math.ceil(d.total / 15) || 1;
  $('#docPager').innerHTML =
    `<button ${docPage <= 1 ? 'disabled' : ''} id="prevDoc">上一页</button>
     <span> ${docPage} / ${pages}（共 ${d.total} 篇）</span>
     <button ${docPage >= pages ? 'disabled' : ''} id="nextDoc">下一页</button>`;
  $('#prevDoc')?.addEventListener('click', () => { docPage--; loadDocs(); });
  $('#nextDoc')?.addEventListener('click', () => { docPage++; loadDocs(); });
  document.querySelectorAll('#docTable .del').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`确认删除文档 #${b.dataset.id}？`)) return;
      await api(`/api/documents/${b.dataset.id}`, { method: 'DELETE' });
      refresh();
    }));
}

async function refresh() { await loadStats(); await loadDocs(); }

$('#addDoc').addEventListener('click', async () => {
  const body = {
    title: $('#dTitle').value, content: $('#dContent').value,
    doc_type: $('#dType').value || 'article', source: $('#dSource').value,
    created_at: $('#dDate').value ? $('#dDate').value.replace('T', ' ') : undefined,
  };
  try {
    const r = await api('/api/documents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    $('#addMsg').textContent = `已入库，文档 ID: ${r.ids.join(',')}`;
    $('#dTitle').value = ''; $('#dContent').value = '';
    refresh();
  } catch (e) { $('#addMsg').textContent = '失败：' + e.message; }
});

$('#bulkBtn').addEventListener('click', async () => {
  try {
    const docs = JSON.parse($('#bulkJson').value);
    const r = await api('/api/documents/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: Array.isArray(docs) ? docs : [docs] }),
    });
    $('#bulkMsg').textContent = `导入 ${r.inserted} 篇，耗时 ${r.tookMs} ms`;
    refresh();
  } catch (e) { $('#bulkMsg').textContent = '失败：' + e.message; }
});

$('#rebuildBtn').addEventListener('click', async () => {
  const r = await api('/api/index/rebuild', { method: 'POST' });
  $('#maintMsg').textContent = `重建完成：${r.rebuilt} 篇，耗时 ${r.tookMs} ms`;
  refresh();
});

$('#clearBtn').addEventListener('click', async () => {
  if (!confirm('确认清空全部文档与索引？该操作不可恢复。')) return;
  await api('/api/index', { method: 'DELETE' });
  $('#maintMsg').textContent = '已清空';
  refresh();
});

refresh();
