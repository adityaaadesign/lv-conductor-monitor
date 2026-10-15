// LOCAL protection – the safety decision made on the controller itself, with no help
// from the laptop server or Wi-Fi.
//
// Trip rule (the same rule the software simulator uses – HARDWARE_ASSUMPTIONS.md A14):
//   A node has NO supply, the node just before it HAS supply, and every node after it
//   also has no supply  →  pattern of a live conductor ending at an interruption.
//   If this lasts tripDelayMs, command the switch OPEN and lock out.
// Not a trip:
//   - every node without supply (source-wide loss: nothing is live, no break pattern);
//   - a pattern involving a node whose sensor reading is invalid (ignored, not "no supply");
//   - low voltage (this rule only looks at present / absent).
// After a trip the switch stays open until someone presses the LOCAL reset button. Then,
// after restoreDelayMs, the command is released. There is NO automatic reclosing.
//
// This logic is a starting point for the firmware author: the real trip rule, delays and
// reset procedure must be agreed with the hardware team and tested on the rig.
#pragma once

#include <cstdint>

#include "types.h"

namespace lvmon {

struct ProtectionSettings {
  bool enabled;
  uint32_t tripDelayMs;     // PLACEHOLDER: how long the break pattern must last before tripping
  uint32_t restoreDelayMs;  // PLACEHOLDER: wait after the reset button before releasing the command
};

struct NodeLive {
  bool sensorOk;   // the latest cycle's reading is valid
  bool present;    // supply present (from SupplyDetector)
};

class Protection {
 public:
  Protection(const NodeConfig* nodes, int count, const ProtectionSettings& settings);

  // Call once per mains cycle with the latest node states.
  void update(int64_t nowMs, const NodeLive live[]);
  // The local reset button was pressed (already debounced).
  void pressReset(int64_t nowMs);
  // What the switch feedback contact currently reports (NOT_FITTED if there is none).
  void setFeedback(Feedback f) { state_.feedback = f; }

  bool relayOpenCommand() const { return state_.isolationCommanded; }
  const ProtectionState& state() const { return state_; }
  // True once after every protection change (trip, reset request, release). The firmware
  // then sends a report immediately, so the server sees the readings from BEFORE the
  // switch moved (HARDWARE_ASSUMPTIONS.md A15).
  bool takeImmediateReportFlag();

  // Exposed for tests: index of the node that matches the break pattern, or -1.
  int breakCandidate(const NodeLive live[]) const;

 private:
  bool isBelow(int node, int ancestor) const;   // is `node` downstream of `ancestor`?

  const NodeConfig* nodes_;
  int count_;
  ProtectionSettings settings_;
  ProtectionState state_;
  int64_t lossSinceMs_ = -1;
  int64_t restoreAtMs_ = -1;
  bool immediate_ = false;
};

}  // namespace lvmon
