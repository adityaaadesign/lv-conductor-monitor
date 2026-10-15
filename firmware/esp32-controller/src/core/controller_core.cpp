#include "controller_core.h"

namespace lvmon {

ControllerCore::ControllerCore(const NodeConfig* nodes, int count, const AdcLimits& adc,
                               const SupplyThresholds& supply, const ProtectionSettings& protection,
                               uint32_t reportIntervalMs, int64_t startMs)
    : nodes_(nodes),
      count_(count > MAX_NODES ? MAX_NODES : count),
      adc_(adc),
      supplyThresholds_(supply),
      protection_(nodes, count > MAX_NODES ? MAX_NODES : count, protection),
      reportIntervalMs_(reportIntervalMs),
      nextReportMs_(startMs + reportIntervalMs) {
  for (int i = 0; i < MAX_NODES; i++) live_[i] = NodeLive{false, true};
}

void ControllerCore::addSample(int node, int raw) {
  if (node >= 0 && node < count_) cycles_[node].add(raw, adc_);
}

void ControllerCore::endCycle(int64_t nowMs) {
  for (int i = 0; i < count_; i++) {
    const CycleResult c = cycles_[i].finish(nodes_[i].voltsPerCount, adc_);
    windows_[i].add(c);
    supply_[i].update(c.volts, c.valid, supplyThresholds_);
    live_[i].sensorOk = c.valid;
    live_[i].present = supply_[i].present();
  }
  // Protection runs every cycle (every 20 ms at 50 Hz) – independent of Wi-Fi.
  protection_.update(nowMs, live_);
  if (protection_.takeImmediateReportFlag()) immediatePending_ = true;
}

Report ControllerCore::takeReport(int64_t nowMs) {
  Report r;
  r.sequence = sequence_++;
  r.uptimeMs = nowMs;
  r.nodeCount = count_;
  for (int i = 0; i < count_; i++) {
    r.nodes[i] = windows_[i].result();
    r.nodes[i].supplyPresent = supply_[i].present();
    r.nodeIncluded[i] = true;
    windows_[i].reset();
  }
  r.protection = protection_.state();
  if (nowMs >= nextReportMs_) {
    // Keep a steady rhythm; if we fell far behind, restart the schedule from now.
    nextReportMs_ += reportIntervalMs_;
    if (nextReportMs_ <= nowMs) nextReportMs_ = nowMs + reportIntervalMs_;
  }
  immediatePending_ = false;
  return r;
}

}  // namespace lvmon
