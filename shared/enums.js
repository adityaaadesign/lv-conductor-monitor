// Every enumerated value used by the server AND the dashboard.
// The browser loads this same file from /shared/enums.js, so the two sides can never
// disagree about spelling. Matches docs/DATA_CONTRACT.md §7.

function makeEnum(...values) {
  return Object.freeze(Object.fromEntries(values.map((v) => [v, v])));
}

export const SCHEMA_VERSION = '1.0';

// IDs for controllers, nodes, sections and switches (DATA_CONTRACT §1).
export const ID_PATTERN = /^[A-Z0-9_-]{1,32}$/;

// The reserved upstream name for the feeder source in config/feeder.json.
export const SOURCE = 'SOURCE';

// ---- Reported by the firmware -------------------------------------------------------
export const SensorStatus = makeEnum(
  'OK', 'NOT_FITTED', 'OUT_OF_RANGE', 'SATURATED', 'ADC_FAULT',
  'NOT_CALIBRATED', 'NO_SIGNAL_REFERENCE', 'UNKNOWN',
);
export const LinkStatus = makeEnum('OK', 'LOST', 'NOT_APPLICABLE');
export const RestoreSource = makeEnum('LOCAL_BUTTON', 'REMOTE_REQUEST', 'AUTOMATIC');
// Values a device may send. CONTRADICTORY / TIMEOUT are derived by the server only.
export const ReportedFeedback = makeEnum('OPEN', 'CLOSED', 'UNKNOWN', 'NOT_FITTED');

// ---- Derived by the server ----------------------------------------------------------
export const NodeValidity = makeEnum('NEVER_SEEN', 'VALID', 'INVALID', 'STALE', 'OFFLINE');

// Why a measurement was not usable. LINK_LOST is a communication problem; the rest
// describe the measurement itself.
export const InvalidReason = makeEnum(
  'LINK_LOST', 'SENSOR_FAULT', 'DATA_FLAGGED_INVALID', 'MISSING_VALUE', 'OUT_OF_RANGE',
  'NO_DATA', 'CONTROLLER_OFFLINE',
);

export const NodeCondition = makeEnum(
  'UNKNOWN', 'NORMAL', 'UV_PENDING', 'UNDERVOLTAGE', 'LOSS_PENDING', 'SUPPLY_LOST', 'RECOVERING',
);

// Voltage band of a single sample (STATE_MACHINE §4.1).
export const Band = makeEnum('OK', 'LOW', 'ABSENT');

export const FeederState = makeEnum(
  'INITIALIZING', 'NORMAL', 'UNDERVOLTAGE', 'TRANSIENT', 'INTERRUPTION_SUSPECTED',
  'ISOLATION_PENDING', 'ISOLATED', 'RECOVERY_CHECK', 'RESTORATION_PENDING', 'RESTORED',
  'DEGRADED', 'UNKNOWN',
);

export const SupplyStatus = makeEnum('PRESENT', 'ABSENT', 'UNKNOWN');

export const LocalizationStatus = makeEnum(
  'NOT_APPLICABLE', 'LOCALIZED_ESTIMATE', 'AMBIGUOUS', 'SOURCE_OR_UPSTREAM',
  'INCONSISTENT', 'INSUFFICIENT_DATA', 'FROZEN',
);

// DE_ENERGISED is display-only: downstream of a switch whose feedback confirms OPEN.
export const SectionStatus = makeEnum(
  'ENERGISED', 'SUSPECTED', 'CANDIDATE', 'NO_SUPPLY', 'UNKNOWN', 'INCONSISTENT', 'DE_ENERGISED',
);

export const RecoveryState = makeEnum(
  'NOT_APPLICABLE', 'WAITING_FOR_SUPPLY', 'STABILITY_CHECK', 'UNSTABLE',
  'STABLE_AWAITING_CONTROLLER', 'RESTORED', 'FAILED',
);

export const IsolationCommandState = makeEnum('NONE', 'COMMANDED', 'RELEASED', 'UNAVAILABLE');
export const IsolationFeedback = makeEnum(
  'OPEN', 'CLOSED', 'UNKNOWN', 'NOT_FITTED', 'CONTRADICTORY', 'TIMEOUT',
);
export const IsolationConfirmed = makeEnum(
  'CONFIRMED', 'NOT_CONFIRMED', 'NO_FEEDBACK_FITTED', 'NOT_APPLICABLE',
);

export const EventType = makeEnum(
  'UNDERVOLTAGE', 'TRANSIENT_DIP', 'INTERRUPTION_SUSPECTED', 'SOURCE_INTERRUPTION_SUSPECTED',
  'NODE_OFFLINE', 'SENSOR_FAULT', 'CONTROLLER_COMM_LOST', 'CONTROLLER_REBOOT',
  'MEASUREMENT_INCONSISTENT', 'ISOLATION_UNCONFIRMED', 'ISOLATION_FEEDBACK_CONTRADICTORY',
  'PROTECTION_DISAGREEMENT', 'SERVER_RESTART',
);

export const Severity = makeEnum('INFO', 'WARNING', 'CRITICAL');
export const EventStatus = makeEnum('OPEN', 'CLOSED');
export const TimestampQuality = makeEnum('EXACT', 'APPROXIMATE', 'UNAVAILABLE');
export const DataSource = makeEnum('LIVE', 'SIMULATED');
export const DataQuality = makeEnum('GOOD', 'DEGRADED', 'NONE');
