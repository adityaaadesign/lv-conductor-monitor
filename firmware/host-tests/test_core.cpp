// PC unit tests for the firmware's core logic (no ESP32 needed).
// Built and run automatically by `npm test` (tests/firmware/firmware-core.test.js),
// or by hand:
//   g++ -std=c++17 -Wall -Wextra -I../esp32-controller/src/core test_core.cpp ../esp32-controller/src/core/*.cpp -o test_core
#include <cmath>
#include <cstdio>
#include <string>

#include "controller_core.h"
#include "protection.h"
#include "report_buffer.h"
#include "report_json.h"
#include "rms.h"
#include "supply.h"

using namespace lvmon;

static int failures = 0;
static int checks = 0;
#define CHECK(cond, msg)                                                   \
  do {                                                                     \
    checks++;                                                              \
    if (!(cond)) { failures++; std::printf("FAIL: %s  (%s:%d)\n", msg, __FILE__, __LINE__); } \
  } while (0)

static const AdcLimits ADC{4095, 8, 1000, 3100, 0.05f};
static const double PI = 3.14159265358979;

// One mains cycle of a sine wave: 40 samples, given DC offset and peak amplitude (counts).
static CycleResult cycleOf(double offset, double peak, float voltsPerCount) {
  CycleAccumulator acc;
  for (int k = 0; k < 40; k++) {
    int raw = static_cast<int>(std::lround(offset + peak * std::sin(2 * PI * k / 40)));
    if (raw < 0) raw = 0;
    if (raw > 4095) raw = 4095;
    acc.add(raw, ADC);
  }
  return acc.finish(voltsPerCount, ADC);
}

static void testRms() {
  // 650-count peak → RMS 459.6 counts → × 0.5 V/count = 229.8 V
  CycleResult c = cycleOf(2048, 650, 0.5f);
  CHECK(c.valid && c.status == SensorStatus::OK, "normal sine is a valid reading");
  CHECK(std::fabs(c.volts - 229.8) < 1.0, "RMS of a sine = peak / sqrt(2)");
  CycleResult shifted = cycleOf(1800, 650, 0.5f);
  CHECK(std::fabs(shifted.volts - c.volts) < 0.5, "DC offset does not change the RMS");

  CycleResult zero = cycleOf(2048, 0, 0.5f);
  CHECK(zero.valid && zero.volts < 0.5, "no AC voltage with the sensor powered = VALID 0 V measurement");

  CycleResult unplugged = cycleOf(0, 0, 0.5f);
  CHECK(!unplugged.valid && unplugged.status == SensorStatus::NO_SIGNAL_REFERENCE, "sensor without offset (unplugged) is INVALID, not 0 V");
  CycleResult railHigh = cycleOf(4095, 0, 0.5f);
  CHECK(railHigh.status == SensorStatus::NO_SIGNAL_REFERENCE, "stuck at full scale is INVALID");

  CycleResult clipped = cycleOf(2048, 3000, 0.5f);
  CHECK(!clipped.valid && clipped.status == SensorStatus::SATURATED, "clipped waveform is SATURATED");

  CycleResult uncal = cycleOf(2048, 650, 0.0f);
  CHECK(uncal.status == SensorStatus::NOT_CALIBRATED, "zero calibration factor is NOT_CALIBRATED");
}

static void testWindow() {
  WindowStats w;
  w.add(cycleOf(2048, 650, 0.5f));
  w.add(cycleOf(2048, 300, 0.5f));
  w.add(cycleOf(2048, 650, 0.5f));
  NodeWindow r = w.result();
  CHECK(r.status == SensorStatus::OK, "window of valid cycles is OK");
  CHECK(r.rmsMin < 110 && r.rmsMax > 229, "window keeps the lowest and highest cycle (short dips visible)");
  w.add(cycleOf(0, 0, 0.5f));
  CHECK(w.result().status == SensorStatus::NO_SIGNAL_REFERENCE, "one invalid cycle marks the window invalid");
  w.reset();
  CHECK(!w.result().hasData, "reset window has no data");
}

static void testSupply() {
  SupplyThresholds t{230, 0.10f, 0.15f};
  SupplyDetector d;
  CHECK(d.present(), "starts as present");
  d.update(20, true, t);   // 0.087 pu < 0.10 → absent
  CHECK(!d.present(), "below loss pickup → absent");
  d.update(30, true, t);   // 0.13 pu: between pickup and dropout → stays absent (hysteresis)
  CHECK(!d.present(), "hysteresis: still absent below dropout");
  d.update(40, true, t);   // 0.17 pu ≥ 0.15 → present
  CHECK(d.present(), "above dropout → present again");
  d.update(0, false, t);   // invalid reading must not change the answer
  CHECK(d.present(), "invalid reading is never taken as 'no supply'");
}

static const NodeConfig LINE[3] = {{"N-A", SOURCE, 0.5f}, {"N-B", 0, 0.5f}, {"N-C", 1, 0.5f}};

static void testProtection() {
  ProtectionSettings s{true, 1000, 2000};
  Protection p(LINE, 3, s);
  NodeLive normal[3] = {{true, true}, {true, true}, {true, true}};
  NodeLive breakAB[3] = {{true, true}, {true, false}, {true, false}};
  NodeLive allDead[3] = {{true, false}, {true, false}, {true, false}};
  NodeLive bInvalid[3] = {{true, true}, {false, false}, {true, false}};
  NodeLive inconsistent[3] = {{true, true}, {true, false}, {true, true}};

  CHECK(p.breakCandidate(normal) == -1, "no break when all present");
  CHECK(p.breakCandidate(breakAB) == 1, "A present, B and C absent → break below A (node B)");
  CHECK(p.breakCandidate(allDead) == -1, "source-wide loss is not a break pattern");
  CHECK(p.breakCandidate(bInvalid) == -1, "an invalid sensor is ignored, never treated as no supply");
  CHECK(p.breakCandidate(inconsistent) == -1, "B absent but C present (sensor fault pattern) → no trip");

  p.update(0, breakAB);
  p.update(980, breakAB);
  CHECK(!p.relayOpenCommand(), "does not trip before the trip delay");
  p.update(1000, breakAB);
  CHECK(p.relayOpenCommand() && p.state().lockout, "trips after the trip delay");
  CHECK(std::string(p.state().tripReason) == "LOSS_OF_SUPPLY_BELOW_N-A", "trip reason names the last node with supply");
  CHECK(p.takeImmediateReportFlag(), "a trip requests an immediate report");
  CHECK(!p.takeImmediateReportFlag(), "the flag is only given once");

  p.update(600000, normal);   // supply looks normal 10 minutes later
  CHECK(p.relayOpenCommand(), "NO automatic reclosing: still open without a reset");

  p.pressReset(600000);
  CHECK(p.state().restoreRequested && p.takeImmediateReportFlag(), "reset button requests restore and a report");
  p.update(601000, normal);
  CHECK(p.relayOpenCommand(), "still open during the restore delay");
  p.update(602000, normal);
  CHECK(!p.relayOpenCommand() && !p.state().lockout, "released only after reset + restore delay");
  CHECK(p.state().tripReason[0] == '\0', "trip reason cleared after release");

  Protection off(LINE, 3, ProtectionSettings{false, 1000, 2000});
  off.update(0, breakAB);
  off.update(5000, breakAB);
  CHECK(!off.relayOpenCommand(), "protection disabled → never trips");

  Protection noTrip(LINE, 3, s);
  noTrip.update(0, breakAB);
  noTrip.update(500, normal);   // pattern clears before the delay
  noTrip.update(1500, breakAB);
  noTrip.update(2400, breakAB);
  CHECK(!noTrip.relayOpenCommand(), "trip timer restarts when the pattern clears");
}

static void testJson() {
  Report r;
  r.sequence = 7;
  r.uptimeMs = 8000;
  r.nodeCount = 2;
  r.nodes[0].hasData = true;
  r.nodes[0].status = SensorStatus::OK;
  r.nodes[0].rmsMean = 229.84f;
  r.nodes[0].rmsMin = 228.0f;
  r.nodes[0].rmsMax = 231.0f;
  r.nodes[0].supplyPresent = true;
  r.nodes[1].hasData = true;
  r.nodes[1].status = SensorStatus::SATURATED;
  r.nodes[1].rmsMean = 412.0f;
  r.nodeIncluded[0] = r.nodeIncluded[1] = true;
  ReportIdentity id{"CTRL-01", "a1b2c3d4", "test", 1000, 20, true, "SW-1"};
  std::string j = buildReportJson(r, id, LINE);
  CHECK(j.find("\"voltage_rms\":229.8") != std::string::npos, "valid voltage with one decimal");
  CHECK(j.find("\"node_id\":\"N-B\",\"voltage_rms\":null") != std::string::npos, "invalid node: voltage is null, never a number");
  CHECK(j.find("\"data_valid\":false,\"sensor_status\":\"SATURATED\"") != std::string::npos, "invalid node: data_valid false + reason");
  CHECK(j.find("\"trip_reason\":null") != std::string::npos, "no trip → trip_reason null");
  CHECK(j.find("\"feedback\":\"NOT_FITTED\"") != std::string::npos, "feedback value from the contract");
  id.hasProtection = false;
  CHECK(buildReportJson(r, id, LINE).find("\"protection\":null") != std::string::npos, "no protection block → null");
}

static void testBuffer() {
  ReportBuffer<3> b;
  for (uint32_t i = 0; i < 5; i++) { Report r; r.sequence = i; b.push(r); }
  CHECK(b.size() == 3 && b.dropped() == 2, "full buffer drops the oldest");
  CHECK(b.oldest().sequence == 2, "oldest kept report is #2");
  b.popOldest();
  CHECK(b.oldest().sequence == 3, "pop removes the oldest");
}

static void testCore() {
  SupplyThresholds t{230, 0.10f, 0.15f};
  ControllerCore core(LINE, 3, ADC, t, ProtectionSettings{true, 1000, 2000}, 1000, 0);
  int64_t now = 0;
  auto runCycle = [&](double peakA, double peakB, double peakC) {
    for (int k = 0; k < 40; k++) {
      const double s = std::sin(2 * PI * k / 40);
      core.addSample(0, static_cast<int>(2048 + peakA * s));
      core.addSample(1, static_cast<int>(2048 + peakB * s));
      core.addSample(2, static_cast<int>(2048 + peakC * s));
    }
    now += 20;
    core.endCycle(now);
  };
  for (int i = 0; i < 49; i++) runCycle(650, 640, 630);
  CHECK(!core.reportDue(now), "no report before one second");
  runCycle(650, 640, 630);
  CHECK(core.reportDue(now), "report due every second");
  Report r = core.takeReport(now);
  CHECK(r.sequence == 0 && r.nodes[0].status == SensorStatus::OK && r.nodes[0].rmsMean > 225, "first report has valid readings");
  // Break between A and B. The pattern is first seen at the end of the first cycle
  // (t = 1020 ms); with a 1000 ms trip delay the trip happens at t = 2020 ms – the 51st cycle.
  for (int i = 0; i < 50; i++) runCycle(650, 0, 0);
  CHECK(!core.relayOpenCommand(), "not tripped before the pattern has lasted 1 s");
  runCycle(650, 0, 0);
  CHECK(core.relayOpenCommand(), "trips once the break pattern has lasted 1 s");
  CHECK(core.reportDue(now), "immediate report after the trip");
  Report trip = core.takeReport(now);
  CHECK(trip.protection.isolationCommanded && trip.sequence == 1, "trip report carries the command");
  CHECK(trip.nodes[1].rmsMean < 1.0f && trip.nodes[0].rmsMean > 225, "trip report holds the readings from before the switch moved");
}

int main() {
  testRms();
  testWindow();
  testSupply();
  testProtection();
  testJson();
  testBuffer();
  testCore();
  if (failures) {
    std::printf("%d of %d checks FAILED\n", failures, checks);
    return 1;
  }
  std::printf("ALL PASSED (%d checks)\n", checks);
  return 0;
}
