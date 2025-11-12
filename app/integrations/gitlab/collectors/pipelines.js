"use strict";
const { avg, max, aggregateStatus, shallowHash } = require("../utils");
const { nowISO, acceptIfUpdated, getSince, setNewest } = require("../state");
const { emitSummaryIfChanged, emitBatchIfChanged } = require("../emit");
const { glGetAll } = require("../api");

const lastSummaryHash = {};
const lastBatchHash = {};

async function collectPipelines(ctx, projectId) {
  const { BASE_URL, TOKEN, MONITOR_LOGS } = ctx;
  const since = getSince("pipelines", projectId);
const encodedProjectId = encodeURIComponent(projectId);

  const items = await glGetAll(
    BASE_URL,
    TOKEN,
    `/projects/${encodedProjectId}/pipelines`,
    {
      updated_after: since,
      order_by: "updated_at",
      sort: "asc",
      per_page: 100,
      with_stats: "true",
    }
  );

  const fresh = [];
  let newest = since;
  for (const p of items) {
    if (!p || p.id == null) continue;
    const u = p.updated_at || p.created_at;
    if (u && u < since) continue;
    if (!acceptIfUpdated("pipelines", projectId, p.id, u)) continue;
    fresh.push(p);
    if (u && u > newest) newest = u;
  }

  const durations = fresh.map((i) => i.duration).filter(Number.isFinite);
  const qTimes = fresh.map((i) => i.queued_duration).filter(Number.isFinite);
  const summary = {
    ts: newest || nowISO(),   
    kind: "pipelines",
    ...aggregateStatus(fresh),
    duration_avg: Number(avg(durations).toFixed(3)),
    duration_max: max(durations) || 0,
    queue_duration_avg: Number(avg(qTimes).toFixed(3)),
    queue_duration_max: max(qTimes) || 0,
  };
  if (fresh.length) {
    if (MONITOR_LOGS) {
      const events = fresh.map((p) => ({
        "@timestamp": p.updated_at || p.created_at,
        event: { kind: "event", action: "pipeline" },
        type: "pipeline",
        projectId,
        id: p.id,
        ref: p.ref,
        status: p.status,
        duration: p.duration ?? null,
        queued_duration: p.queued_duration ?? null,
        web_url: p.web_url,
        created_at: p.created_at,
        updated_at: p.updated_at,
        event_id: `${projectId}:pipeline:${p.id}:${
          p.updated_at || p.created_at
        }`,
      }));
      emitBatchIfChanged(
        shallowHash,
        lastBatchHash,
        `${projectId}:pipelines`,
        events
      );
    }
    emitSummaryIfChanged(
      shallowHash,
      lastSummaryHash,
      `${projectId}:pipelines`,
      summary
    );
  }
  setNewest("pipelines", projectId, newest);
}

module.exports = { collectPipelines };
