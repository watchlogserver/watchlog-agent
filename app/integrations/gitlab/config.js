"use strict";
const fs = require("fs");
const path = require("path");

function loadConfig() {
  const p = path.resolve(__dirname, "../../../integration.json");
  if (!fs.existsSync(p)) throw new Error("[GitLab] integration.json not found");
  const arr = JSON.parse(fs.readFileSync(p, "utf8"));
  const cfg = arr.find((i) => i && i.service === "gitlab");
  if (!cfg || !cfg.monitor)
    throw new Error("[GitLab] Disabled (missing config or monitor=false)");
  const BASE_URL = (cfg.baseUrl || "https://gitlab.com").replace(/\/+$/, "");
  const TOKEN = cfg.token || "";
  const PROJECTS = Array.isArray(cfg.projects) ? cfg.projects : [];
  if (!PROJECTS.length) throw new Error("[GitLab] projects[] is empty");
  const INTERVAL_MS = Math.max(10, Number(cfg.interval || 60)) * 1000;
  const WANT = Object.assign(
    {
      pipelines: true,
      jobs: true,
      runners: true,
      mrs: true,
      deployments: true,
    },
    cfg.metrics || {}
  );
  const MONITOR_LOGS = !!cfg.monitorLogs;
  return { BASE_URL, TOKEN, PROJECTS, INTERVAL_MS, WANT, MONITOR_LOGS };
}

module.exports = { loadConfig };
