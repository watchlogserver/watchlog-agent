"use strict";
const { loadConfig } = require("./config");
const { loadState, saveState } = require("./state");
const { collectPipelines } = require("./collectors/pipelines");
const { collectJobs } = require("./collectors/jobs");
const { collectRunners } = require("./collectors/runners");
const { collectMRs } = require("./collectors/mrs");
const { collectDeployments } = require("./collectors/deployments");

let running = false;

(async function main() {
  let ctx;
  try {
    ctx = loadConfig();
  } catch (e) {
    console.log(e.message);
    return;
  }
  const { BASE_URL, TOKEN, PROJECTS, INTERVAL_MS, WANT } = ctx;
  loadState();

  const JITTER_MS = Math.floor(Math.random() * 2000);
  console.log(
    "[GitLab] Enabled. Projects:",
    PROJECTS.join(", "),
    "| interval:",
    INTERVAL_MS / 1000 + "s"
  );

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const pid of PROJECTS) {
        const tasks = [];
        if (WANT.pipelines) tasks.push(collectPipelines(ctx, pid));
        if (WANT.jobs) tasks.push(collectJobs(ctx, pid));
        if (WANT.runners) tasks.push(collectRunners(ctx, pid));
        if (WANT.mrs) tasks.push(collectMRs(ctx, pid));
        if (WANT.deployments) tasks.push(collectDeployments(ctx, pid));
        try {
          await Promise.all(tasks);
        } catch (e) {
          console.error(`[GitLab] Project ${pid} error:`, e.message);
        }
      }
    } catch (e) {
      console.error("[GitLab] tick error:", e.message);
    } finally {
      saveState();
      running = false;
    }
  }

  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS + JITTER_MS);
  }, JITTER_MS);
})();
