// Shared types for the controller firmware's core logic.
//
// Everything in src/core/ is plain C++17 with NO Arduino or ESP32 code, so it can be
// compiled and tested on a PC (see firmware/host-tests/). The ESP32-specific parts
// (pins, ADC, Wi-Fi, relay) live in esp32-controller.ino.
#pragma once

#include <cstdint>
#include <string>

namespace lvmon {

constexpr int MAX_NODES = 8;   // the report format allows up to 32; 8 is plenty for the prototype
constexpr int SOURCE = -1;     // "upstream" value meaning the node is fed directly from the source

// Values allowed by the data contract (docs/HARDWARE_INTEGRATION.md).
enum class SensorStatus { OK, OUT_OF_RANGE, SATURATED, ADC_FAULT, NOT_CALIBRATED, NO_SIGNAL_REFERENCE, UNKNOWN };
enum class Feedback { OPEN, CLOSED, UNKNOWN, NOT_FITTED };

const char* toString(SensorStatus s);
const char* toString(Feedback f);

// One monitoring point as configured in config.h. Must match config/feeder.json on the server.
struct NodeConfig {
  const char* id;        // e.g. "N-A"
  int upstream;          // index of the node before it, or SOURCE
  float voltsPerCount;   // calibration: RMS volts per RMS ADC count (PLACEHOLDER until calibrated)
};

// Measurements of one node over one report window (about 1 s).
struct NodeWindow {
  bool hasData = false;          // at least one complete mains cycle measured
  float rmsMean = 0;             // average of the per-cycle RMS values (volts)
  float rmsMin = 0;              // lowest per-cycle RMS (volts) – lets the server see short dips
  float rmsMax = 0;              // highest per-cycle RMS (volts)
  SensorStatus status = SensorStatus::UNKNOWN;
  bool supplyPresent = false;    // the controller's own judgement (with hysteresis)
};

// What the controller's local protection is doing.
struct ProtectionState {
  bool enabled = true;
  bool lockout = false;              // tripped; stays isolated until the local reset button
  char tripReason[48] = {};          // empty = none (fixed size: reports are copied byte-by-byte between tasks)
  bool restoreRequested = false;     // reset button pressed, waiting for the restore delay
  bool restorationPermitted = false;
  bool isolationCommanded = false;   // relay is being driven OPEN (the command)
  int64_t commandChangeUptimeMs = -1;  // -1 = never changed
  Feedback feedback = Feedback::NOT_FITTED;  // what the switch actually reports
};

// Everything needed to build one JSON report. Plain data only (no std::string), so the
// ESP32 can copy it through a FreeRTOS queue from the measuring core to the network core.
struct Report {
  uint32_t sequence = 0;
  int64_t uptimeMs = 0;
  int nodeCount = 0;
  NodeWindow nodes[MAX_NODES];
  bool nodeIncluded[MAX_NODES] = {};   // false = leave the node out (e.g. link lost on a remote node)
  ProtectionState protection;
};

}  // namespace lvmon
