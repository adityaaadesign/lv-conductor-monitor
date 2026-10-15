// Simple, beginner-friendly view of the detailed system state.
// Used by the server (to add display fields to the status) and by the dashboard.
//
// Internally the server tracks 12 feeder states (see docs/STATE_MACHINE.md). The simple
// dashboard shows only five. This file is the single place where that mapping is made.

export const DISPLAY_STATUS = {
  NORMAL: {
    label: 'NORMAL',
    tone: 'green',
    meaning: 'All monitoring points have normal voltage.',
  },
  FAULT_SUSPECTED: {
    label: 'FAULT SUSPECTED',
    tone: 'red',
    meaning: 'The readings show a problem (low voltage or lost supply). The system suspects a fault, but voltage readings alone cannot prove that a wire is broken.',
  },
  ISOLATION_PENDING: {
    label: 'ISOLATION PENDING',
    tone: 'red',
    meaning: 'The controller has ordered the switch to open (shutdown), but the switch has NOT confirmed that it opened.',
  },
  ISOLATED: {
    label: 'ISOLATED',
    tone: 'red',
    meaning: 'The controller ordered the shutdown AND the switch feedback signal confirms that the switch is open.',
  },
  DEGRADED_UNKNOWN: {
    label: 'DEGRADED / UNKNOWN',
    tone: 'grey',
    meaning: 'Some or all readings are missing, so the system cannot fully judge the feeder. Missing data is never treated as 0 V and is never taken as a broken line.',
  },
};

// Map the detailed feeder state to one of the five simple statuses.
export function displayStatus(status) {
  switch (status.status) {
    case 'NORMAL':
    case 'TRANSIENT':          // a brief dip that already recovered
    case 'RESTORED':
      return 'NORMAL';
    case 'UNDERVOLTAGE':
    case 'INTERRUPTION_SUSPECTED':
    case 'RECOVERY_CHECK':     // supply coming back – the fault is not cleared yet
      return 'FAULT_SUSPECTED';
    case 'ISOLATION_PENDING':
      return 'ISOLATION_PENDING';
    case 'ISOLATED':
      return 'ISOLATED';
    case 'RESTORATION_PENDING':
      // Only "ISOLATED" if the switch feedback still confirms OPEN.
      return status.isolation_feedback_state === 'OPEN' ? 'ISOLATED' : 'ISOLATION_PENDING';
    default:                   // INITIALIZING, DEGRADED, UNKNOWN
      return 'DEGRADED_UNKNOWN';
  }
}

// What kind of fault, in a few words (shown under the big status).
export function faultKind(status) {
  const t = status.status;
  if (t === 'INITIALIZING') return 'Starting up – waiting for the first readings';
  if (t === 'UNKNOWN') return 'No readings are arriving';
  if (t === 'DEGRADED') return 'Some readings are missing or unreliable';
  if (t === 'UNDERVOLTAGE') return 'Low voltage';
  if (t === 'TRANSIENT') return 'A brief voltage dip was recorded (already recovered)';
  const loc = status.frozen_localization_status ?? status.localization_status;
  if (['INTERRUPTION_SUSPECTED', 'ISOLATION_PENDING', 'ISOLATED', 'RECOVERY_CHECK', 'RESTORATION_PENDING'].includes(t)) {
    return loc === 'SOURCE_OR_UPSTREAM' ? 'Whole feeder has no supply' : 'Supply lost on part of the line';
  }
  return null;
}

// The simple normal / abnormal / unavailable indicator on each node card.
export const NODE_DISPLAY = {
  NORMAL: { label: 'Normal', tone: 'green' },
  LOW_VOLTAGE: { label: 'Low Voltage', tone: 'amber' },
  NO_SUPPLY: { label: 'No Supply', tone: 'red' },
  CHECKING: { label: 'Checking…', tone: 'amber' },
  NO_DATA: { label: 'No Data', tone: 'grey' },
};

// Simple state of one monitoring node. A node without valid data is "NO_DATA" —
// never "NO_SUPPLY" and never shown as 0 V.
export function nodeDisplayState(node) {
  if (node.validity !== 'VALID') return 'NO_DATA';
  switch (node.condition) {
    case 'NORMAL': return 'NORMAL';
    case 'UNDERVOLTAGE': return 'LOW_VOLTAGE';
    case 'SUPPLY_LOST': return 'NO_SUPPLY';
    default: return 'CHECKING';   // waiting to confirm a change (UV_PENDING, LOSS_PENDING, RECOVERING, UNKNOWN)
  }
}

export function nodeCheckingText(node) {
  switch (node.condition) {
    case 'UV_PENDING': return 'Voltage is low – checking that it lasts before calling it a fault.';
    case 'LOSS_PENDING': return 'Voltage has dropped to almost zero – checking that it lasts.';
    case 'RECOVERING': return 'Voltage is back – checking that it stays steady.';
    default: return 'Waiting for enough readings.';
  }
}

// Plain names for the event list.
export const EVENT_SIMPLE = {
  UNDERVOLTAGE: 'Low voltage',
  INTERRUPTION_SUSPECTED: 'Line interruption suspected',
  SOURCE_INTERRUPTION_SUSPECTED: 'Whole feeder lost supply',
  NODE_OFFLINE: 'Node offline (no data)',
  SENSOR_FAULT: 'Sensor problem',
  CONTROLLER_COMM_LOST: 'Controller not reporting',
  ISOLATION_UNCONFIRMED: 'Shutdown not confirmed by switch',
  ISOLATION_FEEDBACK_CONTRADICTORY: 'Switch feedback disagrees with order',
  MEASUREMENT_INCONSISTENT: 'Readings disagree (likely sensor problem)',
  TRANSIENT_DIP: 'Brief voltage dip',
  PROTECTION_DISAGREEMENT: 'Controller and software disagree',
  CONTROLLER_REBOOT: 'Controller restarted',
  SERVER_RESTART: 'Monitoring software restarted',
};

// ---- On-screen test checklists --------------------------------------------------------
// A check is { text, path, equals } or { text, active_event }. path examples:
//   "display_status", "affected_section", "nodes.N-C.display_state".

function readPath(status, path) {
  const parts = path.split('.');
  let cur = status;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    if (parts[i] === 'nodes' && Array.isArray(cur.nodes)) {
      cur = cur.nodes.find((n) => n.node_id === parts[i + 1]);
      i++;
    } else {
      cur = cur[parts[i]];
    }
  }
  return cur;
}

export function checkPasses(check, status) {
  if (check.active_event) return (status.active_events ?? []).some((e) => e.event_type === check.active_event);
  if (check.no_active_fault_events) return !(status.active_events ?? []).some((e) => e.severity !== 'INFO');
  const v = readPath(status, check.path);
  if ('equals' in check) return v === check.equals;
  if ('not_equals' in check) return v !== check.not_equals;
  return false;
}

// ---- Plain-English wording for the dashboard ---------------------------------------------
// All dashboard wording is decided here (not in the browser code), so it can be tested.

const nodeLabelOf = (status, id) => status.nodes?.find((n) => n.node_id === id)?.label ?? id;
const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function sectionWords(status, sectionId) {
  const sec = status.sections?.find((s) => s.section_id === sectionId);
  if (!sec) return sectionId;
  const from = sec.from === 'SOURCE' ? 'the supply' : nodeLabelOf(status, sec.from);
  return `between ${from} and ${nodeLabelOf(status, sec.to)}`;
}

// ONE short sentence explaining why the feeder has its current status.
export function summarySentence(status) {
  const nodes = status.nodes ?? [];
  const names = (pred) => listNames(nodes.filter(pred).map((n) => n.label));
  const loc = status.frozen_localization_status ?? status.localization_status;
  switch (status.status) {
    case 'INITIALIZING':
      return 'Waiting for the first valid readings from all monitoring points.';
    case 'NORMAL':
    case 'RESTORED':
      return 'All valid monitoring points are within configured limits.';
    case 'TRANSIENT':
      return 'A brief voltage dip was recorded, but the voltage recovered before it counted as a fault.';
    case 'UNDERVOLTAGE':
      return `Voltage at ${names((n) => n.condition === 'UNDERVOLTAGE') || 'a monitoring point'} is below the configured threshold.`;
    case 'INTERRUPTION_SUSPECTED':
      if (loc === 'SOURCE_OR_UPSTREAM') return 'No monitoring point has supply; a source-wide outage or an interruption before the first node is suspected.';
      if (loc === 'LOCALIZED_ESTIMATE') return 'Supply is present upstream but absent downstream; an interruption is suspected.';
      return 'Supply is missing at some monitoring points, but the location cannot be narrowed down.';
    case 'RECOVERY_CHECK':
      return 'Supply has returned at the affected points; the fault event stays open until the supply is steady.';
    case 'ISOLATION_PENDING':
      if (status.isolation_feedback_state === 'NOT_FITTED') return 'An isolation command was issued, but this switch has no feedback signal, so opening cannot be confirmed.';
      return 'An isolation command was issued, but switch opening has not been confirmed.';
    case 'ISOLATED':
      return 'An isolation command was issued and the switch feedback confirms the switch is open.';
    case 'RESTORATION_PENDING':
      return 'A reset was requested at the controller; the line stays shut down until the controller decides otherwise.';
    case 'DEGRADED': {
      const lost = names((n) => ['STALE', 'OFFLINE', 'NEVER_SEEN'].includes(n.validity));
      if (lost) return `${lost} ${lost.includes(' and ') ? 'are' : 'is'} not reporting, so the feeder condition cannot be fully determined.`;
      const bad = names((n) => n.validity === 'INVALID');
      if (bad) return `The reading from ${bad} is not valid, so the feeder condition cannot be fully determined.`;
      if (loc === 'INCONSISTENT') return 'The readings contradict each other (probably a sensor problem), so no fault is declared.';
      return 'Some readings are still settling, so the feeder condition cannot be fully determined.';
    }
    case 'UNKNOWN':
      return 'No valid readings are arriving, so the feeder condition is unknown.';
    default:
      return '';
  }
}

// Connection state of a node, judged from the time of its last VALID report:
//   Online      – fresh valid readings
//   Stale Data  – no valid report for longer than stale_after_ms   (config/detection.json)
//   Offline     – no valid report for longer than offline_after_ms (config/detection.json)
//   No Data     – reports arrive but the reading is invalid (sensor problem)
//   Waiting     – nothing received yet
export function connectionState(node) {
  switch (node.validity) {
    case 'VALID': return { key: 'ONLINE', label: 'Online', tone: 'green' };
    case 'STALE': return { key: 'STALE', label: 'Stale Data', tone: 'amber' };
    case 'OFFLINE': return { key: 'OFFLINE', label: 'Offline', tone: 'grey' };
    case 'INVALID': return { key: 'INVALID', label: 'No Data', tone: 'grey' };
    default: return { key: 'WAITING', label: 'Waiting', tone: 'grey' };
  }
}

// Is this node's reading usable? Missing data is never shown as 0 V.
export function readingStatus(node) {
  if (node.validity === 'VALID') return { key: 'VALID', label: 'Valid reading', tone: 'green' };
  if (node.validity === 'INVALID') return { key: 'NO_VALID_READING', label: 'No valid reading', tone: 'grey' };
  if (node.validity === 'NEVER_SEEN') return { key: 'WAITING', label: 'Waiting for first reading', tone: 'grey' };
  return { key: 'CONNECTION_LOST', label: 'Connection lost', tone: 'grey' };   // STALE or OFFLINE
}

// Supply status, only where it can be determined from a valid reading.
export function supplyText(node) {
  if (node.validity !== 'VALID') return 'Unknown';
  switch (node.condition) {
    case 'NORMAL': return 'Supply present';
    case 'UNDERVOLTAGE':
    case 'UV_PENDING': return 'Supply present (low)';
    case 'SUPPLY_LOST': return 'No supply';
    case 'LOSS_PENDING': return 'Possibly no supply (checking)';
    case 'RECOVERING': return 'Supply back (checking)';
    default: return 'Unknown';
  }
}

// The fault-location box. Only a single clear section is an estimate; everything else is
// "Location uncertain". `short` is the one line shown on the main screen; `reason` and
// `observations` are for the "How was the section estimated?" panel.
export function locationView(status) {
  const view = locationDetail(status);
  const loc = status.frozen_localization_status ?? status.localization_status;
  const first = status.nodes?.[0]?.label ?? 'the first node';
  const SHORT = {
    LOCALIZED_ESTIMATE: 'Supply present before this section, absent after it.',
    AMBIGUOUS: 'A node in between has no valid reading.',
    SOURCE_OR_UPSTREAM: `No node has supply – source outage or a fault before ${first}.`,
    INCONSISTENT: 'Readings contradict each other – possibly a sensor problem.',
    INSUFFICIENT_DATA: 'No valid readings to compare.',
  };
  let short = SHORT[loc] ?? '';
  if (!short && status.status === 'UNDERVOLTAGE') short = 'Supply is present everywhere – nothing to locate.';
  if (!short && status.display_status === 'DEGRADED_UNKNOWN') short = 'No supply loss in the valid readings.';
  return { ...view, short };
}

function locationDetail(status) {
  const loc = status.frozen_localization_status ?? status.localization_status;
  const held = status.localization_status === 'FROZEN';
  const observations = status.localization_evidence ?? [];
  switch (loc) {
    case 'LOCALIZED_ESTIMATE':
      return {
        certainty: 'ESTIMATE',
        headline: `Possible interruption ${sectionWords(status, status.affected_section)}`,
        section: status.affected_section,
        reason: held
          ? 'Based on the readings taken just before the shutdown: the point before this section had supply and the points after it had none.'
          : 'The point before this section has supply and the points after it have none.',
        observations,
      };
    case 'AMBIGUOUS':
      return {
        certainty: 'UNCERTAIN',
        headline: 'Location uncertain',
        reason: `Supply is missing, but a monitoring point in between has no valid reading, so it could be ${status.candidate_sections.map((s) => sectionWords(status, s)).join(' or ')}.`,
        observations,
      };
    case 'SOURCE_OR_UPSTREAM':
      return {
        certainty: 'UNCERTAIN',
        headline: 'Location uncertain',
        reason: 'No monitoring point has supply. This fits a source-wide outage or a fault before the first node; the readings cannot tell which, so no section is named.',
        observations,
      };
    case 'INCONSISTENT':
      return {
        certainty: 'UNCERTAIN',
        headline: 'Location uncertain',
        reason: 'The readings contradict each other (a point further along the line has supply although an earlier point shows none). This usually means a sensor problem.',
        observations,
      };
    case 'INSUFFICIENT_DATA':
      return { certainty: 'UNCERTAIN', headline: 'Location uncertain', reason: 'There are no valid readings to compare.', observations: [] };
    default:
      if (status.status === 'UNDERVOLTAGE') {
        return { certainty: 'NONE', headline: 'No interruption detected', reason: 'Supply is present everywhere (one point is low), so there is no interruption to locate.', observations: [] };
      }
      if (status.display_status === 'DEGRADED_UNKNOWN') {
        return { certainty: 'NONE', headline: 'No interruption detected', reason: 'No supply loss is seen in the valid readings. Points without a valid reading are not counted as having lost supply.', observations: [] };
      }
      return { certainty: 'NONE', headline: 'No interruption detected', reason: 'All valid readings show supply present.', observations: [] };
  }
}

// The isolation status: command and feedback are two separate facts.
//   Command:  Not requested / Command issued   (Unknown when the controller is not reporting)
//   Feedback: Confirmed open / Not confirmed / Unavailable   (— when nothing was commanded)
export function shutdownView(status) {
  const cmd = status.isolation_command_state;
  const fb = status.isolation_feedback_state;
  let command;
  if (cmd === 'COMMANDED') command = { text: 'Command issued', tone: 'red', detail: 'The protection controller ordered the switch to open.' };
  else if (cmd === 'UNAVAILABLE') command = { text: 'Unknown', tone: 'grey', detail: 'No report from the protection controller.' };
  else command = { text: 'Not requested', tone: 'green', detail: 'No shutdown has been ordered.' };

  let feedback;
  if (cmd !== 'COMMANDED') {
    feedback = { text: '—', tone: 'grey', detail: 'Nothing to confirm.' };
  } else if (fb === 'OPEN') {
    feedback = { text: 'Confirmed open', tone: 'green', detail: 'The switch feedback signal reports the switch is open.' };
  } else if (fb === 'TIMEOUT' || fb === 'CONTRADICTORY') {
    feedback = {
      text: 'Not confirmed',
      tone: 'red',
      detail: fb === 'TIMEOUT' ? 'No "open" signal within the configured time – the switch may not have opened.' : 'The feedback disagrees with the command.',
    };
  } else if (fb === 'NOT_FITTED') {
    feedback = { text: 'Unavailable', tone: 'grey', detail: 'This switch has no feedback signal, so opening cannot be confirmed.' };
  } else {
    feedback = { text: 'Not confirmed', tone: 'amber', detail: 'Waiting for the switch to report that it is open.' };
  }
  return { command, feedback };
}

// How to draw the switch: open only when feedback confirms it.
export function switchDrawing(status) {
  const cmd = status.isolation_command_state;
  if (cmd === 'UNAVAILABLE') return 'UNKNOWN';
  if (cmd === 'COMMANDED') return status.isolation_feedback_state === 'OPEN' ? 'OPEN_CONFIRMED' : 'OPEN_ORDERED';
  return 'CLOSED';
}
