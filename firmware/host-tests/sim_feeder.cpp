// Runs the FIRMWARE core logic on simulated ADC samples and prints the JSON reports it
// would send, one per line ("<receive_time_ms> <json>"). tests/firmware/firmware-core.test.js
// feeds these reports into the real server pipeline to check that firmware and server agree.
//
// This is a software model only: sine waves at 50 Hz, 2 kHz sampling, a source-side relay
// that opens 60 ms after the command. It does not prove anything about real hardware.
//
// Usage: sim_feeder <scenario>   scenarios: normal | break | break-no-feedback | source-loss | unplugged-b
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "controller_core.h"
#include "report_json.h"

using namespace lvmon;

int main(int argc, char** argv) {
  const std::string scenario = argc > 1 ? argv[1] : "normal";
  const bool feedbackFitted = scenario != "break-no-feedback";
  static const NodeConfig nodes[3] = {{"N-A", SOURCE, 0.5f}, {"N-B", 0, 0.5f}, {"N-C", 1, 0.5f}};
  const AdcLimits adc{4095, 8, 1000, 3100, 0.05f};
  const SupplyThresholds supply{230, 0.10f, 0.15f};
  ControllerCore core(nodes, 3, adc, supply, ProtectionSettings{true, 1000, 2000}, 1000, 0);
  ReportIdentity id{"CTRL-01", "5eedf00d", "host-sim", 1000, 20, true, "SW-1"};

  const double PI = 3.14159265358979;
  const int samplesPerCycle = 40;              // 2000 Hz / 50 Hz
  const double peak[3] = {650, 645, 640};      // ≈ 230 V, 228 V, 226 V at 0.5 V/count
  bool switchClosed = true;
  int64_t switchChangeAt = -1;
  unsigned noise = 12345;

  for (int64_t cycle = 1; cycle <= 1500; cycle++) {   // 30 s
    const int64_t now = cycle * 20;
    // The simulated relay follows the command after 60 ms.
    const bool wantClosed = !core.relayOpenCommand();
    if (wantClosed != switchClosed && switchChangeAt < 0) switchChangeAt = now + 60;
    if (switchChangeAt >= 0 && now >= switchChangeAt) { switchClosed = wantClosed; switchChangeAt = -1; }

    const bool brokenAB = (scenario.rfind("break", 0) == 0) && now > 10000;
    const bool sourceLost = scenario == "source-loss" && now > 10000;
    for (int k = 0; k < samplesPerCycle; k++) {
      const double s = std::sin(2 * PI * k / samplesPerCycle);
      for (int n = 0; n < 3; n++) {
        double amp = peak[n];
        if (!switchClosed || sourceLost) amp = 0;
        if (brokenAB && n >= 1) amp = 0;
        noise = noise * 1103515245u + 12345u;
        const int jitter = static_cast<int>((noise >> 16) % 5) - 2;   // ±2 counts of noise
        int raw = static_cast<int>(std::lround(2048 + amp * s)) + jitter;
        if (scenario == "unplugged-b" && n == 1 && now > 10000) raw = 0;   // sensor lost its supply
        core.addSample(n, raw);
      }
    }
    core.setFeedback(feedbackFitted ? (switchClosed ? Feedback::CLOSED : Feedback::OPEN) : Feedback::NOT_FITTED);
    core.endCycle(now);
    if (core.reportDue(now)) {
      const Report r = core.takeReport(now);
      const std::string line = std::to_string(now) + " " + buildReportJson(r, id, nodes) + "\n";
      std::fputs(line.c_str(), stdout);
    }
  }
  return 0;
}
