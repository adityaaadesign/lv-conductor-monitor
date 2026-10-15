// Builds the JSON report exactly as the server expects (docs/HARDWARE_INTEGRATION.md).
//
// Rule: a value the firmware does not trust is sent as null – never as 0. A node whose
// sensor status is not OK is sent with voltage_rms null and data_valid false.
#pragma once

#include <string>

#include "types.h"

namespace lvmon {

struct ReportIdentity {
  const char* controllerId;     // must match config/feeder.json, e.g. "CTRL-01"
  std::string bootId;           // new random value at every power-up
  const char* firmwareVersion;
  int reportIntervalMs;
  int rmsWindowMs;              // length of one RMS calculation (one mains cycle, e.g. 20)
  bool hasProtection;           // false → "protection": null
  const char* switchId;         // e.g. "SW-1"
};

std::string buildReportJson(const Report& r, const ReportIdentity& id, const NodeConfig* nodes);

}  // namespace lvmon
