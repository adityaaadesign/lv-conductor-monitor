#include "report_json.h"

#include <cmath>
#include <cstdio>

namespace lvmon {

namespace {

// JSON string with the characters that must be escaped.
void putString(std::string& out, const std::string& s) {
  out += '"';
  for (char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (static_cast<unsigned char>(c) < 0x20) out += ' ';
    else out += c;
  }
  out += '"';
}

// Number with one decimal place, or null if it is not a finite number.
void putVolts(std::string& out, float v) {
  if (!std::isfinite(v)) { out += "null"; return; }
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.1f", static_cast<double>(v));
  out += buf;
}

void putInt(std::string& out, long long v) { out += std::to_string(v); }

void putBool(std::string& out, bool b) { out += b ? "true" : "false"; }

}  // namespace

std::string buildReportJson(const Report& r, const ReportIdentity& id, const NodeConfig* nodes) {
  std::string o;
  o.reserve(900);
  o += "{\"schema_version\":\"1.0\",\"controller_id\":";
  putString(o, id.controllerId);
  o += ",\"boot_id\":";
  putString(o, id.bootId);
  o += ",\"sequence_number\":";
  putInt(o, r.sequence);
  o += ",\"uptime_ms\":";
  putInt(o, r.uptimeMs);
  o += ",\"device_time\":null,\"time_synced\":false,\"firmware_version\":";
  putString(o, id.firmwareVersion);
  o += ",\"report_interval_ms\":";
  putInt(o, id.reportIntervalMs);

  o += ",\"nodes\":[";
  bool first = true;
  for (int i = 0; i < r.nodeCount; i++) {
    if (!r.nodeIncluded[i]) continue;
    const NodeWindow& w = r.nodes[i];
    const bool ok = w.hasData && w.status == SensorStatus::OK;
    if (!first) o += ',';
    first = false;
    o += "{\"node_id\":";
    putString(o, nodes[i].id);
    o += ",\"voltage_rms\":";
    if (ok) putVolts(o, w.rmsMean); else o += "null";
    o += ",\"voltage_rms_min\":";
    if (ok) putVolts(o, w.rmsMin); else o += "null";
    o += ",\"voltage_rms_max\":";
    if (ok) putVolts(o, w.rmsMax); else o += "null";
    o += ",\"rms_window_ms\":";
    putInt(o, id.rmsWindowMs);
    o += ",\"current_rms\":null,\"supply_present\":";
    if (ok) putBool(o, w.supplyPresent); else o += "null";
    o += ",\"data_valid\":";
    putBool(o, ok);
    o += ",\"sensor_status\":";
    putString(o, toString(w.hasData ? w.status : SensorStatus::UNKNOWN));
    o += '}';
  }
  o += ']';

  o += ",\"protection\":";
  if (!id.hasProtection) {
    o += "null";
  } else {
    const ProtectionState& p = r.protection;
    o += "{\"protection_enabled\":";
    putBool(o, p.enabled);
    o += ",\"lockout\":";
    putBool(o, p.lockout);
    o += ",\"trip_reason\":";
    if (p.tripReason[0] == '\0') o += "null"; else putString(o, p.tripReason);
    o += ",\"restore_requested\":";
    putBool(o, p.restoreRequested);
    o += ",\"restore_source\":";
    o += p.restoreRequested ? "\"LOCAL_BUTTON\"" : "null";
    o += ",\"restoration_permitted\":";
    putBool(o, p.restorationPermitted);
    o += ",\"switches\":[{\"switch_id\":";
    putString(o, id.switchId);
    o += ",\"isolation_commanded\":";
    putBool(o, p.isolationCommanded);
    o += ",\"commanded_change_uptime_ms\":";
    if (p.commandChangeUptimeMs < 0) o += "null"; else putInt(o, p.commandChangeUptimeMs);
    o += ",\"feedback\":";
    putString(o, toString(p.feedback));
    o += "}]}";
  }
  o += '}';
  return o;
}

}  // namespace lvmon
