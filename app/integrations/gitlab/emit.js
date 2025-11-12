"use strict";
const { emitWhenConnected } = require("./../../socketServer");

const INFLUX_CH = "integrations/gitlab.influx";
const ELASTIC_CH = "integrations/gitlab.elastic";

function emitSummaryIfChanged(hashFn, lastHashMap, key, summary) {
  const h = hashFn(summary);
  if (lastHashMap[key] === h) return false;
  lastHashMap[key] = h;
  emitWhenConnected(INFLUX_CH, [summary]);
  return true;
}

function emitBatchIfChanged(hashFn, lastHashMap, key, events) {
  const h = hashFn(events);
  if (lastHashMap[key] === h) return false;
  lastHashMap[key] = h;
  emitWhenConnected(ELASTIC_CH, events);
  return true;
}

module.exports = {
  emitSummaryIfChanged,
  emitBatchIfChanged,
  INFLUX_CH,
  ELASTIC_CH,
};
