// =====================================================================================
//  ESP32 controller firmware – SKELETON
//  Project: Detection of Breakage in Low-Voltage AC Distributed Overhead Conductors
//
//  STATUS: not compiled for or tested on an ESP32 yet. The core logic in src/core/ is
//  compiled and tested on a PC (firmware/host-tests/), including a check that its reports
//  are accepted by the server. This file (pins, ADC, Wi-Fi, relay, tasks) is untested.
//
//  Structure – two tasks on the two processor cores:
//    Core 1  measureTask : sample ADCs → RMS per cycle → local protection → relay
//                          (never waits for Wi-Fi)
//    Core 0  networkTask : JSON report → HTTP POST to the laptop; buffer when offline
//  A FreeRTOS queue passes finished reports from core 1 to core 0.
//
//  Fill in config.h first. Build with the Arduino IDE + "esp32" boards package.
// =====================================================================================
#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <esp_system.h>
#include <esp_timer.h>

#include <cstring>

#include "config.h"
#include "src/core/controller_core.h"
#include "src/core/report_buffer.h"
#include "src/core/report_json.h"

using namespace lvmon;

static QueueHandle_t reportQueue;
static ReportBuffer<REPORT_BUFFER_SIZE> backlog;   // used only by networkTask
static ReportIdentity identity;
static bool networkConfigured = false;

// ---- Small helpers -------------------------------------------------------------------

static bool isPlaceholder(const char* s) { return std::strstr(s, "PUT_") != nullptr; }

// Debounced digital input: the value must be stable for `needed` consecutive reads.
struct Debounced {
  int pin;
  int stable = -1;
  int last = -1;
  int count = 0;
  int read(int needed = 3) {
    const int v = digitalRead(pin);
    if (v == last) count++; else { last = v; count = 1; }
    if (count >= needed) stable = v;
    return stable;
  }
};

static Debounced feedbackInput{FEEDBACK_PIN};
static Debounced resetInput{RESET_BUTTON_PIN};

static Feedback readFeedback() {
  if (FEEDBACK_PIN < 0) return Feedback::NOT_FITTED;
  const int v = feedbackInput.read();
  if (v < 0) return Feedback::UNKNOWN;   // not stable yet
  return v == FEEDBACK_OPEN_LEVEL ? Feedback::OPEN : Feedback::CLOSED;
}

// True once per press (button to GND with internal pull-up).
static bool resetPressedEdge() {
  static int previous = HIGH;
  if (RESET_BUTTON_PIN < 0) return false;
  const int v = resetInput.read();
  const bool edge = (previous == HIGH && v == LOW);
  if (v >= 0) previous = v;
  return edge;
}

static void driveRelay(bool open) {
  if (RELAY_PIN < 0) return;
  digitalWrite(RELAY_PIN, open ? RELAY_OPEN_LEVEL : !RELAY_OPEN_LEVEL);
}

// ---- Core 1: measuring and local protection ---------------------------------------------

static void measureTask(void*) {
  ProtectionSettings settings = PROTECTION;
  if (RELAY_PIN < 0) settings.enabled = false;   // cannot act without a relay output
  ControllerCore core(NODES, NODE_COUNT, ADC_LIMITS, SUPPLY, settings, REPORT_INTERVAL_MS, millis());
  const int64_t periodUs = 1000000LL / SAMPLE_RATE_HZ;

  for (;;) {
    // One mains cycle of samples, paced by the microsecond timer.
    int64_t next = esp_timer_get_time();
    for (int k = 0; k < SAMPLES_PER_CYCLE; k++) {
      while (esp_timer_get_time() < next) { /* wait for the next sample time */ }
      next += periodUs;
      for (int n = 0; n < NODE_COUNT; n++) core.addSample(n, analogRead(NODE_ADC_PINS[n]));
    }

    const int64_t nowMs = millis();
    core.setFeedback(readFeedback());
    if (resetPressedEdge()) core.pressReset(nowMs);
    core.endCycle(nowMs);                 // RMS + supply check + protection decision
    driveRelay(core.relayOpenCommand());  // act immediately, in this task

    if (core.reportDue(nowMs)) {
      Report r = core.takeReport(nowMs);
      // Never block here: if the queue is full the report is dropped, protection goes on.
      xQueueSend(reportQueue, &r, 0);
    }
    vTaskDelay(1);   // give other tasks on this core a moment (starts a new cycle afterwards)
  }
}

// ---- Core 0: sending reports ---------------------------------------------------------------

enum class SendResult { SENT, REFUSED, UNREACHABLE };

static SendResult sendJson(const std::string& json) {
  if (!networkConfigured || WiFi.status() != WL_CONNECTED) return SendResult::UNREACHABLE;
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(SERVER_URL)) return SendResult::UNREACHABLE;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  const int code = http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(json.c_str())), json.size());
  String body = code > 0 ? http.getString() : String();
  http.end();
  if (code == 200) return SendResult::SENT;
  if (code > 0) {
    // 400/401/409/413: the server answered but refused. Resending the same report will not
    // help, so it is not buffered. The answer explains which field is wrong.
    Serial.printf("SERVER REFUSED (HTTP %d): %s\n", code, body.c_str());
    return SendResult::REFUSED;
  }
  return SendResult::UNREACHABLE;   // timeout / no connection
}

static void ensureWifi() {
  static uint32_t lastAttempt = 0;
  if (!networkConfigured || WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastAttempt < 5000) return;
  lastAttempt = millis();
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

static void networkTask(void*) {
  Report r;
  for (;;) {
    ensureWifi();
    if (xQueueReceive(reportQueue, &r, pdMS_TO_TICKS(1000)) != pdTRUE) continue;
    const std::string json = buildReportJson(r, identity, NODES);
    Serial.printf("REPORT %s\n", json.c_str());   // copy-paste into `npm run check-report`

    // Newest report first, then the backlog (the server stores those as history).
    const SendResult res = sendJson(json);
    if (res == SendResult::UNREACHABLE) {
      backlog.push(r);
      continue;
    }
    for (int i = 0; i < 10 && !backlog.empty(); i++) {
      if (sendJson(buildReportJson(backlog.oldest(), identity, NODES)) == SendResult::UNREACHABLE) break;
      backlog.popOldest();
    }
  }
}

// ---- Start-up ------------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("LV feeder controller – firmware skeleton " FIRMWARE_VERSION);

  for (int n = 0; n < NODE_COUNT; n++) {
    if (NODE_ADC_PINS[n] < 0) {
      // Refuse to run with unset pins rather than reading random inputs.
      for (;;) {
        Serial.println("CONFIG ERROR: set NODE_ADC_PINS in config.h (pins are still -1).");
        delay(5000);
      }
    }
  }
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);   // TODO(hardware): choose to suit the sensor output range

  if (RELAY_PIN >= 0) {
    pinMode(RELAY_PIN, OUTPUT);
    driveRelay(false);   // TODO(hardware): agree the safe start-up state of the switch
  } else {
    Serial.println("WARNING: RELAY_PIN not set – local protection is DISABLED.");
  }
  if (FEEDBACK_PIN >= 0) pinMode(FEEDBACK_PIN, INPUT_PULLUP);   // TODO(hardware): pull-up or not
  if (RESET_BUTTON_PIN >= 0) pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);

  // A new random boot ID at every power-up (required by the data contract).
  char boot[9];
  std::snprintf(boot, sizeof boot, "%08lx", static_cast<unsigned long>(esp_random()));
  identity = ReportIdentity{CONTROLLER_ID, boot, FIRMWARE_VERSION, REPORT_INTERVAL_MS,
                            1000 / MAINS_HZ, true, SWITCH_ID};

  networkConfigured = !isPlaceholder(WIFI_SSID) && !isPlaceholder(SERVER_URL) && !isPlaceholder(DEVICE_KEY);
  if (networkConfigured) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  } else {
    Serial.println("WARNING: Wi-Fi/server/key still placeholders – reports are only printed to Serial.");
  }

  reportQueue = xQueueCreate(4, sizeof(Report));
  xTaskCreatePinnedToCore(measureTask, "measure", 8192, nullptr, 5, nullptr, 1);
  xTaskCreatePinnedToCore(networkTask, "network", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));   // all work happens in the two tasks
}
