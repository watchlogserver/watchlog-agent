"use strict";
const { avg, shallowHash } = require("../utils");
const { nowISO, acceptIfUpdated, getSince, setNewest } = require("../state");
const { emitSummaryIfChanged, emitBatchIfChanged } = require("../emit");
const { glGetAll } = require("../api");

const lastSummaryHash = {};
const lastBatchHash = {};

function toSec(ms) {
  return typeof ms === "number" ? ms / 1000 : ms == null ? null : Number(ms);
}

async function collectMRs(ctx, projectId) {
  const { BASE_URL, TOKEN, MONITOR_LOGS } = ctx;
  const since = getSince("mrs", projectId);
  const encodedProjectId = encodeURIComponent(projectId);
  const mrs = await glGetAll(
    BASE_URL,
    TOKEN,
    `/projects/${encodedProjectId}/merge_requests`,
    {
      updated_after: since,
      state: "all",
      order_by: "updated_at",
      sort: "asc",
      per_page: 100,
    }
  );

  const fresh = [];
  let newest = since;
  const leads = [];
  const stale = [];
  for (const mr of mrs) {
    if (!mr || mr.iid == null) continue;
    const u = mr.updated_at || mr.created_at;
    if (u && u < since) continue;
    if (!acceptIfUpdated("mrs", projectId, mr.iid, u)) continue;

    // first commit time (approx): fetch first page 1 commit
    let firstCommitAt = mr.created_at;
    try {
      const commits = await glGetAll(
        BASE_URL,
        TOKEN,
        `/projects/${projectId}/merge_requests/${mr.iid}/commits`,
        { per_page: 1, page: 1 }
      );
      if (commits[0]?.created_at) firstCommitAt = commits[0].created_at;
    } catch {}

    const lead =
      mr.merged_at && firstCommitAt
        ? (new Date(mr.merged_at) - new Date(firstCommitAt)) / 1000
        : null;
    if (Number.isFinite(lead)) leads.push(lead);
    if (!mr.merged_at && !mr.closed_at) {
      const ageH = (Date.now() - new Date(mr.created_at).getTime()) / 3600_000;
      if (ageH > 48) stale.push(mr.iid);
    }
    fresh.push({ mr, lead });
    if (u && u > newest) newest = u;
  }

  const summary = {
    ts: newest || nowISO(),   
    projectId,
    kind: "mrs",
    total: fresh.length,
    merged: fresh.filter((x) => x.mr.merged_at).length,
    lead_time_avg: Number(avg(leads).toFixed(3)),
    stale_count: stale.length,
  };

  if (fresh.length) {
    if (MONITOR_LOGS) {
      const events = fresh.map(({ mr, lead }) => ({
        "@timestamp": mr.updated_at || mr.created_at,
        event: { kind: "event", action: "merge_request" },
        type: "mr",
        projectId,
        iid: mr.iid,
        id: mr.id,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        state: mr.state,
        merged_at: mr.merged_at,
        created_at: mr.created_at,
        updated_at: mr.updated_at,
        lead_time_sec: Number.isFinite(lead) ? lead : null,
        web_url: mr.web_url,
        event_id: `${projectId}:mr:${mr.iid}:${mr.updated_at || mr.created_at}`,
      }));
      emitBatchIfChanged(
        shallowHash,
        lastBatchHash,
        `${projectId}:mrs`,
        events
      );
    }
    emitSummaryIfChanged(
      shallowHash,
      lastSummaryHash,
      `${projectId}:mrs`,
      summary
    );
  }
  setNewest("mrs", projectId, newest);
}

module.exports = { collectMRs };
