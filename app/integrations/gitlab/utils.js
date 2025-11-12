"use strict";

function avg(a) {
  return !a.length ? 0 : a.reduce((s, n) => s + (Number(n) || 0), 0) / a.length;
}
function max(a) {
  return !a.length ? 0 : Math.max(...a.map(Number).filter(Number.isFinite));
}
function aggregateStatus(items, field = "status") {
  const out = { total: 0 };
  for (const it of items) {
    out.total++;
    const s = ((it && it[field]) || "unknown").toLowerCase();
    out["status_" + s] = (out["status_" + s] || 0) + 1;
  }
  return out;
}
function shallowHash(obj) {
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

module.exports = { avg, max, aggregateStatus, shallowHash };
