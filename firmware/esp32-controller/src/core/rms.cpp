#include "rms.h"

#include <cmath>

namespace lvmon {

void CycleAccumulator::add(int raw, const AdcLimits& limits) {
  sum_ += raw;
  sumSq_ += static_cast<double>(raw) * raw;
  n_++;
  if (raw <= limits.clipMargin || raw >= limits.fullScale - limits.clipMargin) clipped_++;
}

CycleResult CycleAccumulator::finish(float voltsPerCount, const AdcLimits& limits) {
  CycleResult r;
  r.samples = n_;
  r.clipped = clipped_;
  if (n_ > 0) {
    const double mean = sum_ / n_;
    double variance = sumSq_ / n_ - mean * mean;
    if (variance < 0) variance = 0;   // rounding can make it very slightly negative
    r.meanCounts = static_cast<float>(mean);
    r.volts = static_cast<float>(std::sqrt(variance) * voltsPerCount);

    if (mean < limits.midMin || mean > limits.midMax) {
      r.status = SensorStatus::NO_SIGNAL_REFERENCE;   // offset missing: sensor unpowered / disconnected
    } else if (clipped_ > limits.maxClippedFraction * n_) {
      r.status = SensorStatus::SATURATED;             // waveform hitting the ADC limits
    } else if (voltsPerCount <= 0) {
      r.status = SensorStatus::NOT_CALIBRATED;
    } else {
      r.status = SensorStatus::OK;
      r.valid = true;
    }
  }
  sum_ = sumSq_ = 0;
  n_ = clipped_ = 0;
  return r;
}

// Order of seriousness used to pick the "worst" status in a window.
static int severity(SensorStatus s) {
  switch (s) {
    case SensorStatus::OK: return 0;
    case SensorStatus::UNKNOWN: return 1;
    case SensorStatus::OUT_OF_RANGE: return 2;
    case SensorStatus::NOT_CALIBRATED: return 3;
    case SensorStatus::SATURATED: return 4;
    case SensorStatus::NO_SIGNAL_REFERENCE: return 5;
    case SensorStatus::ADC_FAULT: return 6;
  }
  return 1;
}

void WindowStats::add(const CycleResult& c) {
  cycles_++;
  if (severity(c.status) > severity(worst_)) worst_ = c.status;
  if (!c.valid) return;
  if (okCycles_ == 0) {
    min_ = max_ = c.volts;
  } else {
    if (c.volts < min_) min_ = c.volts;
    if (c.volts > max_) max_ = c.volts;
  }
  sum_ += c.volts;
  okCycles_++;
}

NodeWindow WindowStats::result() const {
  NodeWindow w;
  w.hasData = cycles_ > 0;
  w.status = cycles_ == 0 ? SensorStatus::UNKNOWN : worst_;
  if (okCycles_ > 0) {
    w.rmsMean = static_cast<float>(sum_ / okCycles_);
    w.rmsMin = min_;
    w.rmsMax = max_;
  }
  return w;
}

void WindowStats::reset() {
  cycles_ = okCycles_ = 0;
  sum_ = 0;
  min_ = max_ = 0;
  worst_ = SensorStatus::OK;
}

const char* toString(SensorStatus s) {
  switch (s) {
    case SensorStatus::OK: return "OK";
    case SensorStatus::OUT_OF_RANGE: return "OUT_OF_RANGE";
    case SensorStatus::SATURATED: return "SATURATED";
    case SensorStatus::ADC_FAULT: return "ADC_FAULT";
    case SensorStatus::NOT_CALIBRATED: return "NOT_CALIBRATED";
    case SensorStatus::NO_SIGNAL_REFERENCE: return "NO_SIGNAL_REFERENCE";
    case SensorStatus::UNKNOWN: return "UNKNOWN";
  }
  return "UNKNOWN";
}

const char* toString(Feedback f) {
  switch (f) {
    case Feedback::OPEN: return "OPEN";
    case Feedback::CLOSED: return "CLOSED";
    case Feedback::UNKNOWN: return "UNKNOWN";
    case Feedback::NOT_FITTED: return "NOT_FITTED";
  }
  return "UNKNOWN";
}

}  // namespace lvmon
