/**
 * cache.js — 检索结果 LRU 缓存。
 *
 * - 键：查询参数的稳定序列化；
 * - 索引任何写操作（增/删/改/重建）后通过 bumpEpoch 整体失效；
 * - 容量有限，超出时淘汰最久未使用的条目。
 */
const MAX_ENTRIES = 200;

let epoch = 0;
const store = new Map(); // key -> { epoch, value }

function stableKey(obj) {
  const keys = Object.keys(obj).sort();
  return keys.map((k) => `${k}=${obj[k] ?? ''}`).join('&');
}

function get(params) {
  const key = stableKey(params);
  const entry = store.get(key);
  if (!entry || entry.epoch !== epoch) return null;
  // LRU：命中后移到末尾
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

function set(params, value) {
  const key = stableKey(params);
  if (store.has(key)) store.delete(key);
  store.set(key, { epoch, value });
  if (store.size > MAX_ENTRIES) {
    store.delete(store.keys().next().value);
  }
}

/** 索引变更后调用，使全部缓存条目失效。 */
function bumpEpoch() {
  epoch++;
  if (store.size > MAX_ENTRIES * 4) store.clear();
}

function stats() {
  return { size: store.size, max: MAX_ENTRIES, epoch };
}

module.exports = { get, set, bumpEpoch, stats };
