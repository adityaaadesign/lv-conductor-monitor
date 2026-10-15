// User-facing labels, colour tones and plain-language descriptions.
// Used by the dashboard and by the server's explanation text. Tones:
//   green = normal, amber = warning, red = abnormal / needs attention, grey = unknown / no valid data.
// Colour is never the only cue: every tone also has a text label and an icon shape.

export const TONE_ICON = { green: '●', amber: '▲', red: '■', grey: '◌' };

export const FEEDER_STATE_INFO = {
  INITIALIZING: { label: 'Initializing', tone: 'grey', summary: 'Waiting for valid data from the configured nodes.' },
  NORMAL: { label: 'Normal', tone: 'green', summary: 'All nodes report valid voltage in the normal band.' },
  UNDERVOLTAGE: { label: 'Undervoltage', tone: 'amber', summary: 'At least one node has stayed below the undervoltage pickup for the persistence time.' },
  TRANSIENT: { label: 'Brief voltage dip', tone: 'amber', summary: 'A short dip was detected and supply recovered before it could be confirmed as sustained.' },
  INTERRUPTION_SUSPECTED: { label: 'Interruption suspected', tone: 'red', summary: 'Valid measurements show loss of supply. The cause is not proven.' },
  ISOLATION_PENDING: { label: 'Isolation commanded – not confirmed', tone: 'red', summary: 'The controller reports it has commanded isolation, but no feedback confirms the switch is open.' },
  ISOLATED: { label: 'Isolated (feedback confirmed)', tone: 'red', summary: 'The controller commanded isolation and the switch feedback reports OPEN.' },
  RECOVERY_CHECK: { label: 'Recovery check', tone: 'amber', summary: 'Supply has returned; checking that it stays stable.' },
  RESTORATION_PENDING: { label: 'Restoration pending', tone: 'amber', summary: 'Waiting for the controller to re-energise the feeder under its own interlocks.' },
  RESTORED: { label: 'Restored', tone: 'green', summary: 'Supply returned and stayed stable for the configured period.' },
  DEGRADED: { label: 'Degraded data', tone: 'amber', summary: 'No electrical abnormality detected, but some node data is missing, invalid or inconsistent.' },
  UNKNOWN: { label: 'Unknown – no valid data', tone: 'grey', summary: 'The server is not receiving valid data. This is not evidence of an interruption.' },
};

export const NODE_CONDITION_INFO = {
  UNKNOWN: { label: 'Unknown', tone: 'grey' },
  NORMAL: { label: 'Normal', tone: 'green' },
  UV_PENDING: { label: 'Low – confirming', tone: 'amber' },
  UNDERVOLTAGE: { label: 'Undervoltage', tone: 'amber' },
  LOSS_PENDING: { label: 'No supply – confirming', tone: 'amber' },
  SUPPLY_LOST: { label: 'No supply', tone: 'red' },
  RECOVERING: { label: 'Recovering', tone: 'amber' },
};

export const VALIDITY_INFO = {
  NEVER_SEEN: { label: 'No data yet', tone: 'grey' },
  VALID: { label: 'Valid', tone: 'green' },
  INVALID: { label: 'Invalid data', tone: 'grey' },
  STALE: { label: 'Stale', tone: 'grey' },
  OFFLINE: { label: 'Offline', tone: 'grey' },
};

export const INVALID_REASON_TEXT = {
  LINK_LOST: 'Link to node lost (reported by controller)',
  SENSOR_FAULT: 'Sensor fault reported',
  DATA_FLAGGED_INVALID: 'Firmware flagged the reading as invalid',
  MISSING_VALUE: 'Voltage value missing',
  OUT_OF_RANGE: 'Reading outside the sensor range',
  NO_DATA: 'No data received',
  CONTROLLER_OFFLINE: 'Controller offline',
};

export const SEVERITY_INFO = {
  INFO: { label: 'Info', tone: 'grey' },
  WARNING: { label: 'Warning', tone: 'amber' },
  CRITICAL: { label: 'Critical', tone: 'red' },
};

export const EVENT_TYPE_INFO = {
  UNDERVOLTAGE: { label: 'Undervoltage', description: 'Node voltage stayed below the undervoltage pickup for the persistence time.' },
  TRANSIENT_DIP: { label: 'Brief voltage dip', description: 'Voltage dipped and recovered before a sustained condition was confirmed.' },
  INTERRUPTION_SUSPECTED: { label: 'Interruption suspected', description: 'Supply absent at one or more nodes with valid data. Consistent with a broken conductor, open switch, blown fuse or loose joint — not proof of a break.' },
  SOURCE_INTERRUPTION_SUSPECTED: { label: 'Source / feeder-wide interruption suspected', description: 'No node has supply. Cannot distinguish a source outage from a break before the first node.' },
  NODE_OFFLINE: { label: 'Node offline', description: 'No usable data from the node. Communication problem — not evidence of an interruption.' },
  SENSOR_FAULT: { label: 'Sensor fault', description: 'The node reported an invalid measurement.' },
  CONTROLLER_COMM_LOST: { label: 'Controller communication lost', description: 'No reports from the controller. Local protection on the controller is unaffected.' },
  CONTROLLER_REBOOT: { label: 'Controller restarted', description: 'The controller reported a new boot ID.' },
  MEASUREMENT_INCONSISTENT: { label: 'Inconsistent measurements', description: 'A node reports no supply while a node downstream of it has supply. Treated as a probable measurement fault, not an interruption.' },
  ISOLATION_UNCONFIRMED: { label: 'Isolation not confirmed', description: 'Isolation was commanded but the switch feedback did not report OPEN within the timeout.' },
  ISOLATION_FEEDBACK_CONTRADICTORY: { label: 'Contradictory isolation feedback', description: 'Switch feedback disagrees with the commanded state.' },
  PROTECTION_DISAGREEMENT: { label: 'Controller/server disagreement', description: "The controller's own supply judgement differs from the server's. Usually a threshold mismatch." },
  SERVER_RESTART: { label: 'Monitoring server restarted', description: 'The server restarted. Conditions during the downtime were not observed.' },
};

export const LOCALIZATION_INFO = {
  NOT_APPLICABLE: { label: 'No interruption to locate', tone: 'green' },
  LOCALIZED_ESTIMATE: { label: 'Estimated section', tone: 'red', explanation: 'Upstream node has supply and the downstream node does not (both with valid data). The interruption is most likely within this section. Exact position within the section cannot be determined.' },
  AMBIGUOUS: { label: 'Location uncertain – several candidate sections', tone: 'amber', explanation: 'One or more nodes between the last node with supply and the first node without supply have no valid data, so more than one section could be affected.' },
  SOURCE_OR_UPSTREAM: { label: 'Source or first section – cannot distinguish', tone: 'red', explanation: 'No node has supply. A source outage and a break between the source and the first node look identical without a source-side reference sensor.' },
  INCONSISTENT: { label: 'Inconsistent pattern – no section claimed', tone: 'amber', explanation: 'A node downstream of a "no supply" node still has supply. In a radial feeder this is physically inconsistent, so a measurement fault is more likely than an interruption.' },
  INSUFFICIENT_DATA: { label: 'Insufficient data', tone: 'grey', explanation: 'No node has valid data, so nothing can be located.' },
  FROZEN: { label: 'Held from before isolation', tone: 'red', explanation: 'Isolation de-energises the downstream nodes on purpose, so the location estimate is held from the measurements taken before the switch opened.' },
};

export const SECTION_STATUS_INFO = {
  ENERGISED: { label: 'Energised', tone: 'green' },
  SUSPECTED: { label: 'Interruption suspected (estimate)', tone: 'red' },
  CANDIDATE: { label: 'Candidate (location uncertain)', tone: 'amber' },
  NO_SUPPLY: { label: 'No supply (downstream of interruption)', tone: 'grey' },
  UNKNOWN: { label: 'Unknown', tone: 'grey' },
  INCONSISTENT: { label: 'Inconsistent readings', tone: 'amber' },
  DE_ENERGISED: { label: 'De-energised by isolation (feedback OPEN)', tone: 'grey' },
};

export const RECOVERY_INFO = {
  NOT_APPLICABLE: { label: 'Not applicable', tone: 'grey' },
  WAITING_FOR_SUPPLY: { label: 'Waiting for supply / restoration', tone: 'red' },
  STABILITY_CHECK: { label: 'Stability check running', tone: 'amber' },
  UNSTABLE: { label: 'Unstable – timer reset', tone: 'red' },
  STABLE_AWAITING_CONTROLLER: { label: 'Stable – awaiting controller', tone: 'amber' },
  RESTORED: { label: 'Restored', tone: 'green' },
  FAILED: { label: 'Restoration failed – supply did not return', tone: 'red' },
};

export const ISOLATION_COMMAND_INFO = {
  NONE: { label: 'Not commanded', tone: 'green' },
  COMMANDED: { label: 'Commanded', tone: 'red' },
  RELEASED: { label: 'Released (reclose commanded)', tone: 'amber' },
  UNAVAILABLE: { label: 'No protection status received', tone: 'grey' },
};

export const ISOLATION_FEEDBACK_INFO = {
  OPEN: { label: 'OPEN (feedback)', tone: 'red' },
  CLOSED: { label: 'CLOSED (feedback)', tone: 'green' },
  UNKNOWN: { label: 'Unknown', tone: 'grey' },
  NOT_FITTED: { label: 'No feedback fitted', tone: 'grey' },
  CONTRADICTORY: { label: 'Contradictory', tone: 'red' },
  TIMEOUT: { label: 'Not confirmed – timeout', tone: 'red' },
};

export const ISOLATION_CONFIRMED_INFO = {
  CONFIRMED: { label: 'Confirmed by feedback', tone: 'red' },
  NOT_CONFIRMED: { label: 'Not confirmed', tone: 'red' },
  NO_FEEDBACK_FITTED: { label: 'Cannot confirm – no feedback fitted', tone: 'grey' },
  NOT_APPLICABLE: { label: 'Not requested', tone: 'grey' },
};

export const REASON_TEXT = {
  WAITING_FOR_DATA: 'Waiting for valid data from all nodes',
  ALL_NODES_NORMAL: 'All nodes normal',
  NODE_UNDERVOLTAGE: 'Node voltage below undervoltage pickup for the persistence time',
  NODE_SUPPLY_LOST: 'Supply absent at a node (valid data)',
  UPSTREAM_PRESENT_DOWNSTREAM_ABSENT: 'Upstream supply present, downstream supply absent',
  ALL_NODES_ABSENT: 'No node has supply',
  LOCATION_AMBIGUOUS: 'Location ambiguous – missing data between nodes',
  LOCATION_UNKNOWN: 'Location could not be estimated',
  PATTERN_INCONSISTENT: 'Measurement pattern physically inconsistent',
  NODE_DATA_STALE: 'Node data stale',
  NODE_OFFLINE: 'Node offline',
  SENSOR_INVALID: 'Sensor reported invalid data',
  NODE_NEVER_REPORTED: 'Node has not reported since start',
  NODE_RECOVERING: 'Node recovering after an abnormal condition',
  CONTROLLER_OFFLINE: 'Controller offline',
  NO_VALID_NODE_DATA: 'No node has valid data',
  MONITORING_RESUMED: 'Monitoring resumed',
  ISOLATION_COMMANDED: 'Controller commanded isolation',
  ISOLATION_FEEDBACK_OPEN: 'Switch feedback reports OPEN',
  ISOLATION_FEEDBACK_TIMEOUT: 'Switch feedback did not confirm OPEN in time',
  FEEDBACK_NOT_FITTED: 'No switch feedback fitted – isolation cannot be confirmed',
  FEEDBACK_CONTRADICTORY: 'Switch feedback contradicts command',
  FEEDBACK_UNCOMMANDED_OPEN: 'Switch reports OPEN although not commanded',
  AWAITING_FEEDBACK: 'Waiting for switch feedback',
  AWAITING_SWITCH_CLOSE: 'Waiting for switch to report CLOSED',
  PROTECTION_TRIP_REPORTED: 'Controller reported a protection trip',
  LOCALIZED_FROM_TRIP_REPORT: 'Location estimated from samples in the trip report (before isolation)',
  RESTORE_REQUESTED: 'Restore requested at the controller',
  AWAITING_CONTROLLER_RESTORE: 'Supply stable – awaiting controller restoration',
  RECLOSE_REPORTED: 'Controller reports switch reclosed',
  WAITING_FOR_SUPPLY: 'Waiting for supply to return',
  SUPPLY_RETURNED: 'Supply returned – stability check running',
  RECOVERY_RESET_BY_ABNORMALITY: 'Supply became abnormal again – stability timer reset',
  RESTORATION_FAILED: 'Supply did not return after reclose',
  RECOVERY_STABLE: 'Supply stable for the configured period',
  AFFECTED_NODE_DATA_UNAVAILABLE: 'Cannot confirm recovery – affected node has no valid data',
  TRANSIENT_DIP_DETECTED: 'Brief voltage dip detected',
};
