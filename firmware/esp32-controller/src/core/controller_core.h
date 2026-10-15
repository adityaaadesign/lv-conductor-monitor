// The controller's main logic in one place, independent of the ESP32:
//   samples → per-cycle RMS → supply present? → local protection → report every second
//
// The ESP32 sketch only has to:
//   1. call addSample() for every ADC sample of every node,
//   2. call endCycle() after each mains cycle (e.g. every 40 samples at 2 kHz / 50 Hz),
//   3. drive the relay from relayOpenCommand(), feed setFeedback() and pressReset(),
//   4. when reportDue() is true, call takeReport() and hand the report to the network task.
#pragma once

#include <cstdint>

#include "protection.h"
#include "rms.h"
#include "supply.h"
#include "types.h"

namespace lvmon {

class ControllerCore {
 public:
  ControllerCore(const NodeConfig* nodes, int count, const AdcLimits& adc, const SupplyThresholds& supply,
                 const ProtectionSettings& protection, uint32_t reportIntervalMs, int64_t startMs);

  void addSample(int node, int raw);
  void endCycle(int64_t nowMs);

  void setFeedback(Feedback f) { protection_.setFeedback(f); }
  void pressReset(int64_t nowMs) { protection_.pressReset(nowMs); }
  bool relayOpenCommand() const { return protection_.relayOpenCommand(); }

  // True when the regular report is due, or immediately after a protection change.
  bool reportDue(int64_t nowMs) const { return immediatePending_ || nowMs >= nextReportMs_; }
  // Snapshot of the current window; starts a new window and increments the sequence number.
  Report takeReport(int64_t nowMs);

  const ProtectionState& protectionState() const { return protection_.state(); }

 private:
  const NodeConfig* nodes_;
  int count_;
  AdcLimits adc_;
  SupplyThresholds supplyThresholds_;
  Protection protection_;
  uint32_t reportIntervalMs_;
  int64_t nextReportMs_;
  uint32_t sequence_ = 0;
  bool immediatePending_ = false;
  CycleAccumulator cycles_[MAX_NODES];
  WindowStats windows_[MAX_NODES];
  SupplyDetector supply_[MAX_NODES];
  NodeLive live_[MAX_NODES];
};

}  // namespace lvmon
