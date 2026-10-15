// "Is supply present at this node?" with hysteresis, judged once per mains cycle.
//
// Two thresholds (per-unit of the nominal voltage) stop the answer flickering when the
// voltage hovers near one value:
//   present → absent  when voltage < lossPickupPu  × nominal
//   absent  → present when voltage ≥ lossDropoutPu × nominal
// The same placeholder values are used by the server (config/detection.json).
#pragma once

namespace lvmon {

struct SupplyThresholds {
  float nominalVolts;    // PLACEHOLDER: actual test-supply voltage
  float lossPickupPu;    // e.g. 0.10 (PLACEHOLDER) – must be above the sensor noise floor
  float lossDropoutPu;   // e.g. 0.15 (PLACEHOLDER) – must be above lossPickupPu
};

class SupplyDetector {
 public:
  // volts: this cycle's RMS. valid: false if the sensor reading is not usable.
  // An invalid reading keeps the previous answer (it is never taken as "no supply").
  void update(float volts, bool valid, const SupplyThresholds& t) {
    if (!valid) return;
    const float pu = volts / t.nominalVolts;
    present_ = present_ ? (pu >= t.lossPickupPu) : (pu >= t.lossDropoutPu);
  }
  bool present() const { return present_; }

 private:
  bool present_ = true;
};

}  // namespace lvmon
