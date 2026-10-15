#include "protection.h"

#include <cstdio>

namespace lvmon {

Protection::Protection(const NodeConfig* nodes, int count, const ProtectionSettings& settings)
    : nodes_(nodes), count_(count), settings_(settings) {
  state_.enabled = settings.enabled;
}

bool Protection::isBelow(int node, int ancestor) const {
  int cur = nodes_[node].upstream;
  for (int guard = 0; cur != SOURCE && guard < count_; guard++) {
    if (cur == ancestor) return true;
    cur = nodes_[cur].upstream;
  }
  return false;
}

int Protection::breakCandidate(const NodeLive live[]) const {
  for (int i = 0; i < count_; i++) {
    if (!live[i].sensorOk || live[i].present) continue;            // need a VALID "no supply"
    const int up = nodes_[i].upstream;
    if (up == SOURCE) continue;                                     // nothing known before it
    if (!live[up].sensorOk || !live[up].present) continue;          // the node before must have supply
    bool allBelowDead = true;
    for (int j = 0; j < count_; j++) {
      if (isBelow(j, i) && live[j].sensorOk && live[j].present) { allBelowDead = false; break; }
    }
    if (allBelowDead) return i;
  }
  return -1;
}

void Protection::update(int64_t nowMs, const NodeLive live[]) {
  // A local reset was pressed earlier: release the command once the delay has passed.
  if (state_.restoreRequested && nowMs >= restoreAtMs_) {
    state_.restoreRequested = false;
    state_.lockout = false;
    state_.tripReason[0] = '\0';
    state_.isolationCommanded = false;
    state_.commandChangeUptimeMs = nowMs;
    lossSinceMs_ = -1;
    immediate_ = true;
  }
  if (!settings_.enabled || state_.lockout) return;

  const int cand = breakCandidate(live);
  if (cand < 0) {
    lossSinceMs_ = -1;
    return;
  }
  if (lossSinceMs_ < 0) lossSinceMs_ = nowMs;
  if (nowMs - lossSinceMs_ >= static_cast<int64_t>(settings_.tripDelayMs)) {
    state_.isolationCommanded = true;
    state_.lockout = true;
    state_.restorationPermitted = false;
    std::snprintf(state_.tripReason, sizeof state_.tripReason, "LOSS_OF_SUPPLY_BELOW_%s", nodes_[nodes_[cand].upstream].id);
    state_.commandChangeUptimeMs = nowMs;
    immediate_ = true;
  }
}

void Protection::pressReset(int64_t nowMs) {
  if (!state_.lockout || state_.restoreRequested) return;   // only meaningful after a trip
  state_.restoreRequested = true;
  state_.restorationPermitted = true;   // PLACEHOLDER: real interlock checks belong here
  restoreAtMs_ = nowMs + settings_.restoreDelayMs;
  immediate_ = true;
}

bool Protection::takeImmediateReportFlag() {
  const bool f = immediate_;
  immediate_ = false;
  return f;
}

}  // namespace lvmon
