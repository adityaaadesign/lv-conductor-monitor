// RMS voltage measurement from raw ADC samples.
//
// A voltage sensor module gives the ESP32 an AC waveform riding on a DC offset (about
// mid-scale). For each mains cycle we collect the raw samples and compute:
//   mean     = average of the samples             (the DC offset)
//   rmsCount = sqrt(average of (sample - mean)^2)  (the AC part only, in ADC counts)
//   volts    = rmsCount * voltsPerCount            (calibration factor from config.h)
// Using the variance removes the DC offset automatically, so no fixed offset is needed.
//
// The mean is also a health check: if it sits near 0 or near full scale, the sensor has
// no signal reference (unpowered or disconnected). That is reported as an INVALID
// reading – which is different from a valid measurement of 0 V.
#pragma once

#include "types.h"

namespace lvmon {

struct AdcLimits {
  int fullScale;             // e.g. 4095 for a 12-bit ADC
  int clipMargin;            // a sample within this many counts of 0 or full scale counts as clipped
  int midMin;                // the DC offset (mean) must lie between midMin and midMax,
  int midMax;                //   otherwise the sensor has no signal reference
  float maxClippedFraction;  // more clipped samples than this fraction → SATURATED
};

struct CycleResult {
  bool valid = false;        // true only if the cycle produced a usable RMS value
  float volts = 0;           // RMS volts for this cycle
  float meanCounts = 0;
  int samples = 0;
  int clipped = 0;
  SensorStatus status = SensorStatus::UNKNOWN;
};

// Collects the samples of ONE mains cycle for one node.
class CycleAccumulator {
 public:
  void add(int raw, const AdcLimits& limits);
  // Computes the cycle's RMS and resets for the next cycle.
  CycleResult finish(float voltsPerCount, const AdcLimits& limits);
  int samples() const { return n_; }

 private:
  double sum_ = 0;
  double sumSq_ = 0;
  int n_ = 0;
  int clipped_ = 0;
};

// Combines the per-cycle results of one report window (about 1 s) for one node.
class WindowStats {
 public:
  void add(const CycleResult& c);
  // Mean/min/max of the valid cycles. Status is the worst status seen in the window,
  // so one bad cycle marks the whole window's reading as invalid.
  NodeWindow result() const;
  void reset();

 private:
  int cycles_ = 0;
  int okCycles_ = 0;
  double sum_ = 0;
  float min_ = 0;
  float max_ = 0;
  SensorStatus worst_ = SensorStatus::OK;
};

}  // namespace lvmon
