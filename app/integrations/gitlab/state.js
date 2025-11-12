"use strict";
const fs = require("fs");
const path = require("path");

const STATE_PATH = path.resolve(__dirname, "./gitlab-state.json");
const state = {
  lastSeen: { pipelines: {}, jobs: {}, mrs: {}, deployments: {} },
  seenUpdated: { pipelines: {}, jobs: {}, mrs: {}, deployments: {} },
};

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH))
      Object.assign(state, JSON.parse(fs.readFileSync(STATE_PATH, "utf8")));
  } catch {}
}
function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch {}
}

function nowISO() {
  return new Date().toISOString();
}
function toISO(x) {
  try {
    return new Date(x).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function acceptIfUpdated(kind, projectId, id, uISO) {
  const bag = (state.seenUpdated[kind][projectId] ||= {});
  const prev = bag[id] || "";
  if (!uISO || uISO <= prev) return false;
  bag[id] = uISO;
  const keys = Object.keys(bag);
  if (keys.length > 5000) {
    for (let i = 0; i < 1000; i++) delete bag[keys[i]];
  }
  return true;
}

function getSince(kind, projectId) {
  const base =
    state.lastSeen[kind][projectId] ||
    new Date(Date.now() - 3600_000).toISOString();
  return new Date(new Date(base).getTime() - 60_000).toISOString();
}

function setNewest(kind, projectId, iso) {
  state.lastSeen[kind][projectId] = toISO(iso);
}

module.exports = {
  state,
  loadState,
  saveState,
  nowISO,
  toISO,
  acceptIfUpdated,
  getSince,
  setNewest,
};
