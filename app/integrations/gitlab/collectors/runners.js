"use strict";
const { shallowHash } = require("../utils");
const { nowISO } = require("../state");
const { emitSummaryIfChanged, emitBatchIfChanged } = require("../emit");
const { glGetAll } = require("../api");

const lastSummaryHash = {};
const lastBatchHash = {};

async function collectRunners(ctx, projectId) {
  const { BASE_URL, TOKEN, MONITOR_LOGS } = ctx;
const encodedProjectId = encodeURIComponent(projectId);
  
  const items = await glGetAll(
    BASE_URL,
    TOKEN,
    `/projects/${encodedProjectId}/runners`,
    { per_page: 100 }
  );
  const online = items.filter((r) => r && r.status === "online").length;
  const summary = {
    ts: nowISO(),   
    projectId,
    kind: "runners",
    total: items.length,
    online,
    offline: Math.max(0, items.length - online),
  };

  emitSummaryIfChanged(
    shallowHash,
    lastSummaryHash,
    `${projectId}:runners`,
    summary
  );

  if (MONITOR_LOGS && items.length) {
    const events = items.map((r) => ({
      "@timestamp": r.contacted_at || summary.ts,
      event: { kind: "metric", action: "runner" },
      type: "runner",
      projectId,
      id: r.id,
      description: r.description,
      status: r.status,
      is_shared: !!r.is_shared,
      locked: !!r.locked,
      contacted_at: r.contacted_at,
      event_id: `${projectId}:runner:${r.id}:${r.contacted_at || summary.ts}`,
    }));
    emitBatchIfChanged(
      shallowHash,
      lastBatchHash,
      `${projectId}:runners`,
      events
    );
  }
}

module.exports = { collectRunners };
