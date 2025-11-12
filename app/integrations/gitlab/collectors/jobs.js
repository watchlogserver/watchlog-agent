"use strict";
const { avg, max, aggregateStatus, shallowHash } = require("../utils");
const { nowISO, acceptIfUpdated, getSince, setNewest } = require("../state");
const { emitSummaryIfChanged, emitBatchIfChanged } = require("../emit");
const { glGetAll } = require("../api");

const lastSummaryHash = {};
const lastBatchHash = {};

async function collectJobs(ctx, projectId) {
  const { BASE_URL, TOKEN, MONITOR_LOGS } = ctx;
  const since = getSince("jobs", projectId);
const encodedProjectId = encodeURIComponent(projectId);
  
  const items = await glGetAll(BASE_URL, TOKEN, `/projects/${encodedProjectId}/jobs`, {
    scope: [
      "created",
      "pending",
      "running",
      "failed",
      "success",
      "canceled",
      "skipped",
    ],
    order_by: "updated_at",
    sort: "asc",
    per_page: 100,
    updated_after: since,
  });

  const fresh = [];
  let newest = since;
  for (const j of items) {
    if (!j || j.id == null) continue;
    const u = j.updated_at || j.created_at;
    if (u && u < since) continue;
    if (!acceptIfUpdated("jobs", projectId, j.id, u)) continue;
    fresh.push(j);
    if (u && u > newest) newest = u;
  }

  const durations = fresh.map((i) => i.duration).filter(Number.isFinite);
  const qTimes = fresh.map((i) => i.queued_duration).filter(Number.isFinite);
  const summary = {
    ts: newest || nowISO(),   
    projectId,
    kind: "jobs",
    ...aggregateStatus(fresh),
    duration_avg: Number(avg(durations).toFixed(3)),
    duration_max: max(durations) || 0,
    queue_duration_avg: Number(avg(qTimes).toFixed(3)),
    queue_duration_max: max(qTimes) || 0,
  };

  if (fresh.length) {
    if (MONITOR_LOGS) {
      const events = fresh.map((j) => ({
        "@timestamp": j.updated_at || j.created_at,
        event: { kind: "event", action: "job" },
        type: "job",
        projectId,
        id: j.id,
        name: j.name,
        stage: j.stage,
        status: j.status,
        duration: j.duration ?? null,
        queued_duration: j.queued_duration ?? null,
        web_url: j.web_url,
        created_at: j.created_at,
        started_at: j.started_at,
        finished_at: j.finished_at,
        updated_at: j.updated_at,
        event_id: `${projectId}:job:${j.id}:${j.updated_at || j.created_at}`,
      }));
      emitBatchIfChanged(
        shallowHash,
        lastBatchHash,
        `${projectId}:jobs`,
        events
      );
    }
    emitSummaryIfChanged(
      shallowHash,
      lastSummaryHash,
      `${projectId}:jobs`,
      summary
    );
  }
  setNewest("jobs", projectId, newest);
}

module.exports = { collectJobs };
