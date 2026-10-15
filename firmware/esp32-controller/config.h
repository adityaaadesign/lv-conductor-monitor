// =====================================================================================
//  CONTROLLER SETTINGS – fill in before uploading.
//
//  Everything marked TODO(hardware) depends on the real circuit and must be decided by
//  the hardware team. Values marked PLACEHOLDER are starting values only, not validated
//  engineering settings. The firmware refuses to measure until the pins are set, and
//  reports readings as NOT_CALIBRATED until the calibration factors are set.
// =====================================================================================
#pragma once

#include "src/core/types.h"
#include "src/core/rms.h"
#include "src/core/supply.h"
#include "src/core/protection.h"

// ---- Wi-Fi and server ----------------------------------------------------------------
// WARNING: never commit the real Wi-Fi password or device key to GitHub. Fill them in only
// on the computer that flashes the ESP32, and do not commit that version of this file.
#define WIFI_SSID         "PUT_WIFI_NAME_HERE"
#define WIFI_PASSWORD     "PUT_WIFI_PASSWORD_HERE"
// Where reports go. Two choices:
//   Cloudflare (online):  "https://lv-monitor-api.<your-subdomain>.workers.dev/api/v1/telemetry"
//   Laptop (bench test):  "http://<laptop-ip>:8080/api/v1/telemetry"  (server.json "host": "0.0.0.0")
#define SERVER_URL        "PUT_SERVER_URL_HERE"
// Same text as DEVICE_KEYS on the server (Cloudflare secret, or config/devices.local.json
// on the laptop) – only the part after "CTRL-01=".
#define DEVICE_KEY        "PUT_THE_SAME_KEY_AS_ON_THE_SERVER"

// HTTPS (Cloudflare): the root certificate that signed the server's certificate, in PEM
// text. TODO(firmware): fill in before using an https:// URL – see docs/DEPLOYMENT.md
// ("HTTPS on the ESP32"). Several certificates may be pasted one after another.
// Not needed for an http:// laptop URL. Without it, https:// reports are not sent
// (the firmware never turns certificate checking off).
static const char SERVER_ROOT_CA[] = "PUT_ROOT_CA_PEM_HERE";
#define HTTP_TIMEOUT_MS   800      // keep short; protection never waits for the network

// ---- Identity (must match config/feeder.json) ----------------------------------------
#define CONTROLLER_ID     "CTRL-01"
#define SWITCH_ID         "SW-1"
#define FIRMWARE_VERSION  "0.1.0-skeleton"

// ---- Monitoring points (order and upstream links must match config/feeder.json) -----
// voltsPerCount = RMS volts per RMS ADC count. 0 means "not calibrated yet":
// the node is then reported as NOT_CALIBRATED (invalid), never as a voltage.
// Find the value with `npm run calibrate` on the laptop (multimeter comparison).
static const lvmon::NodeConfig NODES[] = {
  {"N-A", lvmon::SOURCE, 0.0f},   // PLACEHOLDER calibration
  {"N-B", 0, 0.0f},               // upstream = index 0 (N-A); PLACEHOLDER calibration
  {"N-C", 1, 0.0f},               // upstream = index 1 (N-B); PLACEHOLDER calibration
};
static const int NODE_COUNT = sizeof(NODES) / sizeof(NODES[0]);

// TODO(hardware): ADC input pin for each node, same order as NODES. -1 = not set.
// Note: on the classic ESP32, ADC2 pins cannot be read while Wi-Fi is on, so the
// sensors must be wired to ADC1-capable pins (check the board's pinout).
static const int NODE_ADC_PINS[] = {-1, -1, -1};

// ---- Sampling ------------------------------------------------------------------------
#define MAINS_HZ              50      // TODO(hardware): confirm supply frequency
#define SAMPLE_RATE_HZ        2000    // PLACEHOLDER: samples per second per node
#define SAMPLES_PER_CYCLE     (SAMPLE_RATE_HZ / MAINS_HZ)
#define REPORT_INTERVAL_MS    5000    // PLACEHOLDER: must match REPORT_INTERVAL_MS in cloudflare/wrangler.toml
                                      // (laptop server: expected_report_interval_ms in config/detection.json)

// ADC health limits for a 12-bit ADC (0..4095). TODO(hardware): set from the sensor's
// actual DC offset. A mean outside midMin..midMax means "no signal reference" (invalid).
static const lvmon::AdcLimits ADC_LIMITS = {4095, 8, 1000, 3100, 0.05f};

// ---- Supply detection (same PLACEHOLDER values as config/detection.json) -------------
static const lvmon::SupplyThresholds SUPPLY = {
  230.0f,   // PLACEHOLDER nominal voltage of the test supply
  0.10f,    // PLACEHOLDER loss pickup (per-unit) – must be above the sensor noise floor
  0.15f,    // PLACEHOLDER loss dropout (per-unit)
};

// ---- Local protection ------------------------------------------------------------------
static const lvmon::ProtectionSettings PROTECTION = {
  true,     // protection enabled (forced off if RELAY_PIN is not set)
  1000,     // PLACEHOLDER trip delay (ms)
  2000,     // PLACEHOLDER delay after the local reset button before releasing (ms)
};

// TODO(hardware): relay output. -1 = not set → protection is disabled and reported so.
#define RELAY_PIN             -1
#define RELAY_OPEN_LEVEL      HIGH    // TODO(hardware): output level that OPENS the switch

// TODO(hardware): switch feedback contact. -1 = no feedback contact fitted
// (the dashboard will then never show "Shutdown confirmed by feedback").
#define FEEDBACK_PIN          -1
#define FEEDBACK_OPEN_LEVEL   LOW     // TODO(hardware): input level when the switch is OPEN

// TODO(hardware): local reset push-button (to GND, internal pull-up). -1 = none.
#define RESET_BUTTON_PIN      -1

// Reports kept in memory while Wi-Fi or the server is unavailable.
#define REPORT_BUFFER_SIZE    30
