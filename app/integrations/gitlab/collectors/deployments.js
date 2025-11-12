"use strict";
const { shallowHash } = require("../utils");
const { nowISO, acceptIfUpdated, getSince, setNewest } = require("../state");
const { emitSummaryIfChanged, emitBatchIfChanged } = require("../emit");
const { glGetAll } = require("../api");

const lastSummaryHash = {};
const lastBatchHash = {};

async function collectDeployments(ctx, projectId) {
  const { BASE_URL, TOKEN, MONITOR_LOGS } = ctx;
  const since = getSince("deployments", projectId);
const encodedProjectId = encodeURIComponent(projectId);
  
  const items = await glGetAll(
    BASE_URL,
    TOKEN,
    `/projects/${encodedProjectId}/deployments`,
    {
      updated_after: since,
      order_by: "updated_at",
      sort: "asc",
      per_page: 100,
    }
  );

  const fresh = [];
  let newest = since;
  let success = 0;
  let failed = 0;
  for (const d of items) {
    if (!d || d.id == null) continue;
    const u = d.updated_at || d.created_at;
    if (u && u < since) continue;
    if (!acceptIfUpdated("deployments", projectId, d.id, u)) continue;
    fresh.push(d);
    if (u && u > newest) newest = u;
    if (d.status === "success") success++;
    else if (d.status === "failed") failed++;
  }

  const summary = {
    ts: newest || nowISO(),   
    projectId,
    kind: "deployments",
    total: fresh.length,
    success,
    failed,
    cfr:
      success + failed
        ? Number((failed / (success + failed)).toFixed(3))
        : null,
  };

  if (fresh.length) {
    if (MONITOR_LOGS) {
      const events = fresh.map((d) => ({
        "@timestamp": d.updated_at || d.created_at,
        event: { kind: "event", action: "deployment" },
        type: "deployment",
        projectId,
        id: d.id,
        iid: d.iid,
        status: d.status,
        environment: d.environment?.name || d.environment,
        created_at: d.created_at,
        updated_at: d.updated_at,
        ref: d.ref,
        sha: d.sha,
        user: d.user?.username,
        web_url: d.web_url,
        event_id: `${projectId}:deployment:${d.id}:${
          d.updated_at || d.created_at
        }`,
      }));
      emitBatchIfChanged(
        shallowHash,
        lastBatchHash,
        `${projectId}:deployments`,
        events
      );
    }
    emitSummaryIfChanged(
      shallowHash,
      lastSummaryHash,
      `${projectId}:deployments`,
      summary
    );
  }
  setNewest("deployments", projectId, newest);
}

module.exports = { collectDeployments };
