# Detection Logic, Localization and State Machine

**Status:** Phase 1 design. This is the specification the Phase 3 code and unit tests
are written against. Every threshold below is a **configurable placeholder**, not a
validated engineering setting; see §2.

---

## 1. Layered model (why there is no single `isFault` flag)

```
 validated measurements ──► [A] Node data validity     (per node: is the data usable?)
                                   │ only VALID data passes
                                   ▼
                            [B] Node electrical condition (per node: normal / low / lost, with timers)
                                   │
                                   ▼
                            [C] Localization            (feeder: which section, how sure?)
                                   │
 controller protection ───► [D] Feeder state machine    (feeder: overall supervisory state)
 status (commanded,               │
 feedback, lockout)               ▼
                            [E] Event manager           (history: open / update / close incidents)
```

Separate pieces of state are kept for each concern and shown separately on the dashboard:

| Concern | Where it lives | Example values |
|---|---|---|
| Data validity / communication health | layer A, per node & per controller | `VALID`, `STALE`, `OFFLINE` |
| Electrical condition | layer B, per node | `UNDERVOLTAGE`, `SUPPLY_LOST` |
| Localization | layer C | `LOCALIZED_ESTIMATE` S-AB |
| Isolation **command** | from controller | `COMMANDED` |
| Isolation **feedback** | from controller | `OPEN`, `NOT_FITTED`, `TIMEOUT` |
| Recovery | layer B timers + layer D | `STABILITY_CHECK` 6.0 / 10.0 s |
| Overall feeder state | layer D | `ISOLATED` |

All layers are pure functions of `(previous state, input, now)`. Time comes from an
injected clock, so the same input sequence always produces the same transitions.

---

## 2. Configuration parameters (`config/detection.json`)

Voltage thresholds are expressed **per-unit (pu) of `nominal_voltage_v`** configured
for the test setup, so the same logic works whether the prototype runs at 12 V, 24 V
or another isolated LV level.

> **All values are placeholders** chosen only so the simulator has something to run.
> Before any measured test, set them from (a) the sensor's reading with supply
> removed (noise floor), (b) the normal variation of the test supply, (c) the
> report interval actually used by the firmware, and (d) the relay's operate time.
> Record the final values and their justification in the test report.

| Parameter | Meaning | Placeholder |
|---|---|---|
| `nominal_voltage_v` | Nominal RMS voltage of the test feeder (in `feeder.json`) | set by hardware |
| `sensor_full_scale_v` | Highest credible reading; above → `OUT_OF_RANGE` | set by hardware |
| `uv_pickup_pu` | Enter LOW band when V falls below | 0.90 |
| `uv_dropout_pu` | Leave LOW band when V rises to at least (hysteresis) | 0.93 |
| `loss_pickup_pu` | Enter ABSENT band when V falls below (must be above sensor noise floor) | 0.10 |
| `loss_dropout_pu` | Leave ABSENT band when V rises to at least | 0.15 |
| `transient_dip_pu` | A dip deeper than this (in sample or `voltage_rms_min`) counts as a transient | 0.80 |
| `uv_persistence_ms` | LOW must persist this long to confirm undervoltage | 3000 |
| `loss_persistence_ms` | ABSENT must persist this long to confirm supply loss | 2000 |
| `recovery_stability_ms` | Supply must stay in the normal band this long to be called stable | 10000 |
| `restored_hold_ms` | `RESTORED` is shown this long before returning to `NORMAL` and closing the event | 5000 |
| `reclose_supply_timeout_ms` | After a reported reclose, affected nodes must regain supply within this time, else recovery `FAILED` | 5000 |
| `expected_report_interval_ms` | Firmware report period | 1000 |
| `stale_after_ms` | No accepted data from a node for this long → `STALE` | 3000 |
| `offline_after_ms` | … → `OFFLINE` | 10000 |
| `controller_offline_after_ms` | No report from a controller for this long → controller offline | 10000 |
| `init_timeout_ms` | Max time in `INITIALIZING` before going `DEGRADED` | 15000 |
| `isolation_feedback_timeout_ms` | After isolation is commanded, feedback must show `OPEN` within this time | 3000 |
| `transient_display_hold_ms` | How long the feeder shows `TRANSIENT` | 5000 |
| `transient_max_events_per_min` | Per feeder; extra dips are counted, not logged individually | 6 |
| `protection_disagreement_ms` | Controller vs server supply judgement must disagree this long to log it | 5000 |
| `tick_interval_ms` | Periodic re-evaluation for timer expiry | 250 |

Startup validation rejects inconsistent settings, e.g. `uv_dropout_pu ≤ uv_pickup_pu`,
`loss_pickup_pu ≥ uv_pickup_pu`, `stale_after_ms ≤ expected_report_interval_ms`.

**Effective resolution:** a persistence time shorter than the report interval cannot
be honoured — with 1 s reports, "2000 ms" means "about 2–3 consecutive reports".
The dashboard shows the configured value and the report interval side by side.

---

## 3. Layer A — node data validity

Evaluated on every report for that node and on every tick.

| Validity | Condition |
|---|---|
| `NEVER_SEEN` | No accepted measurement since server start |
| `VALID` | Latest accepted measurement passed all value checks (DATA_CONTRACT §4) **and** is younger than `stale_after_ms` |
| `INVALID` | Latest measurement failed a check (`data_valid=false`, sensor fault, link lost, out of range, missing value). Reason kept. |
| `STALE` | Latest accepted message older than `stale_after_ms` |
| `OFFLINE` | … older than `offline_after_ms`, or its controller is offline |

Rules:

- A measurement marked invalid **only because the link to the node was lost**
  (`link_status: "LOST"`) is treated as *missing data*, not as a sensor fault: the node
  stays `VALID` on its last good sample until `stale_after_ms`, then becomes `STALE` /
  `OFFLINE`. Any other invalid reason makes the node `INVALID` immediately.
- Only `VALID` measurements feed layer B. Everything else leaves layer B frozen at its
  last known condition and marks it *last known*, with timestamp.
- When a node leaves `VALID`, its **pending** timers (`UV_PENDING`, `LOSS_PENDING`,
  `RECOVERING`) are cancelled: an abnormality or a recovery cannot be confirmed without data.
- The dashboard shows non-valid nodes in grey with the last valid value and its age —
  never as 0 V.

> ⚠ **Hardware dependency:** if a node's electronics are powered from the line it
> measures, losing supply also silences the node, which is indistinguishable from a
> communication failure. The software will then (correctly) report `OFFLINE`, not
> `SUPPLY_LOST`. See HARDWARE_ASSUMPTIONS A5.

---

## 4. Layer B — node electrical condition

### 4.1 Voltage band with hysteresis

For each valid sample `v = voltage_rms / nominal_voltage_v`:

```
 ABSENT  if v < loss_pickup_pu,  or (previous band was ABSENT and v < loss_dropout_pu)
 LOW     else if v < uv_pickup_pu, or (previous band was LOW    and v < uv_dropout_pu)
 OK      otherwise
```

### 4.2 Node condition transitions

| From | Band / event | To | Output |
|---|---|---|---|
| `UNKNOWN` | OK | `NORMAL` | — |
| `UNKNOWN` | LOW / ABSENT | `UV_PENDING` / `LOSS_PENDING` (timer starts now) | — |
| `NORMAL` | LOW | `UV_PENDING`, `first_observed = now` | — |
| `NORMAL` | ABSENT | `LOSS_PENDING`, `first_observed = now` | — |
| `NORMAL` | OK but `voltage_rms_min < transient_dip_pu` | `NORMAL` | **transient** (in-window dip) |
| `UV_PENDING` | OK | `NORMAL` | **transient** (dip shorter than `uv_persistence_ms`) |
| `UV_PENDING` | LOW, time since the **first abnormal sample** ≥ `uv_persistence_ms` | `UNDERVOLTAGE` | confirmed |
| `UV_PENDING` | ABSENT | `LOSS_PENDING` (keeps `first_observed`; absent timer starts now) | — |
| `LOSS_PENDING` | OK | `NORMAL` | **transient** (momentary loss) |
| `LOSS_PENDING` | LOW | `UV_PENDING` (keeps `first_observed`), or back to `UNDERVOLTAGE` if that was already confirmed | — |
| `LOSS_PENDING` | ABSENT **continuously** ≥ `loss_persistence_ms` | `SUPPLY_LOST` | confirmed |
| `UNDERVOLTAGE` | ABSENT | `LOSS_PENDING` | — |
| `UNDERVOLTAGE` | OK | `RECOVERING` (stability timer starts) | supply returned |
| `SUPPLY_LOST` | OK | `RECOVERING` (stability timer starts) | supply returned |
| `SUPPLY_LOST` | LOW | `UNDERVOLTAGE` | partial return |
| `RECOVERING` | LOW / ABSENT | back to `UNDERVOLTAGE` / `SUPPLY_LOST` immediately | **recovery unstable** (timer reset, count +1) |
| `RECOVERING` | OK, elapsed ≥ `recovery_stability_ms` | `NORMAL` | **recovery stable**, `stable_since` = timer start |
| any pending | node leaves `VALID` | last confirmed condition (frozen) | timers cancelled |

Persistence confirmations are also checked on every periodic tick (not only when a
report arrives), provided the node's data is still `VALID`.

A return to the abnormal state from `RECOVERING` is immediate (no new persistence
period) because the node was already in a confirmed abnormal condition — this is the
conservative choice and is what "an unstable recovery must reset the stability timer"
requires.

### 4.3 Transient detection — what the hardware allows

| Firmware provides | What can be detected | What cannot |
|---|---|---|
| Only `voltage_rms` averaged over the report interval *T* | Dips that last across at least one report boundary | A dip of depth *d* and duration *t* < *T* only lowers the average by roughly *d·t/T* and may be invisible. Duration known only to ±*T*. |
| Also `voltage_rms_min` from per-cycle RMS (`rms_window_ms` ≈ 20 ms) | Dips lasting at least one RMS window, even between reports | Exact dip duration (only "occurred within this report window"); sub-cycle events |
| Raw waveform capture | (out of scope for v1) | — |

The dashboard displays the active resolution, taken from `capabilities.transient_detection`
in `feeder.json` (`NONE`, `REPORT_INTERVAL`, `PER_RMS_WINDOW`). Transients are never
claimed at a finer resolution than declared.

---

## 5. Layer C — localization

### 5.1 Inputs

Topology from `config/feeder.json` is a **radial tree**: each node names its
`upstream` (another node or `SOURCE`), and each node–upstream link is a named section.
A straight line `SOURCE → N-A → N-B → N-C` is the simplest case. An optional
`source_reference_node` is a sensor at the source terminals.

Each node's supply status for localization:

| Status | From node condition |
|---|---|
| `PRESENT` | `NORMAL`, `UV_PENDING`, `UNDERVOLTAGE`, `RECOVERING` (supply is there, possibly low) |
| `ABSENT` | `SUPPLY_LOST` (confirmed, valid data) |
| `UNKNOWN` | node not `VALID`, or `LOSS_PENDING`, or `UNKNOWN` |

### 5.2 Algorithm

1. If no node is `ABSENT` → `NOT_APPLICABLE`.
2. **Consistency check.** If any `PRESENT` node has an `ABSENT` ancestor → `INCONSISTENT`.
   In a radial feeder, supply cannot reach a node through a dead section; the likely
   explanations are a faulty sensor at the absent node, backfeed, or a topology config
   error. No section is claimed.
3. For each **top-most absent** node (an `ABSENT` node whose upstream is not `ABSENT`),
   walk upstream through `UNKNOWN` nodes until reaching a `PRESENT` node or `SOURCE`.
   Every section on that walk is a **candidate**.
4. If the walk reached `SOURCE` without a `PRESENT` node:
   - if the source is known to be energised — a `source_reference_node` is `PRESENT`, or
     **any** node anywhere on the feeder is `PRESENT` (in a radial feeder its supply must
     come from the source) — the source→first-node section is a candidate;
   - otherwise (no node has supply) → `SOURCE_OR_UPSTREAM` (event type
     `SOURCE_INTERRUPTION_SUSPECTED`). The software cannot tell a source outage from a
     break between source and the first node.
5. Result:
   - exactly one candidate section → `LOCALIZED_ESTIMATE`
   - more than one candidate (unknown nodes in between, or separate absent branches) → `AMBIGUOUS` with the list
   - no `VALID` node at all → `INSUFFICIENT_DATA`
6. **Evidence text** is generated from the same data, e.g.
   *"N-A: supply present (229.4 V, valid, 09:15:02). N-B: supply absent (0.6 V, valid). N-C: supply absent (0.4 V, valid). → Interruption suspected between N-A and N-B (section S-AB)."*

### 5.3 Freezing during isolation

When the controller commands isolation, nodes downstream of that switch are *expected*
to lose supply. From that moment the localization result is **frozen** (status `FROZEN`,
original evidence kept)

Because local protection is normally faster than the server's persistence timers, the
controller may trip before the server has *confirmed* any loss. The frozen result then
uses the **samples in the report that first carried the isolation command** — these were
measured before the switch opened — treating a node whose latest sample is in the ABSENT
band (`LOSS_PENDING`) as absent. The evidence text says so (reason
`LOCALIZED_FROM_TRIP_REPORT`). This relies on assumption A15 (HARDWARE_ASSUMPTIONS).

From the moment of freezing, downstream zero readings are not treated as new evidence —
otherwise opening a source-side switch would make every interruption look feeder-wide.
Which nodes lie downstream of which switch is declared in `feeder.json`
(`isolation_points[].de_energises_nodes`).

### 5.4 What localization can and cannot tell you

It **can** say: "with valid data, supply is present at the upstream end and absent at
the downstream end of section X, so the interruption is most likely within section X".

It **cannot** say:
- that a conductor is physically broken — the same pattern results from an open switch,
  blown fuse, loose terminal or failed joint in that section;
- where inside the section the problem is (resolution = node spacing);
- anything about a section where one end has no valid data;
- the difference between a source outage and a break before the first node (without a source reference);
- the order of events that occur within one report interval;
- breaks where the downstream end is held up by backfeed (e.g. through loads or capacitors)
  — these may appear as undervoltage, not loss;
- high-impedance faults that do not remove downstream voltage.

Therefore the user-facing wording is always *"interruption suspected"* and *"estimated
section"*, never *"conductor broken"*.

---

## 6. Layer D — feeder state machine

### 6.1 Inputs per evaluation

- node validities and conditions (layers A, B), localization (layer C)
- controller online/offline
- protection status: `isolation_commanded`, switch `feedback`, `lockout`, `restore_requested`
- the open incident (if any): its affected nodes, frozen localization, unstable count

### 6.2 State precedence

When several conditions hold at once the most important wins:
`UNKNOWN` > controller-reported isolation/restoration states > `INTERRUPTION_SUSPECTED` >
`UNDERVOLTAGE` > `TRANSIENT` > `DEGRADED` > `NORMAL`.
Degraded data *during* an incident does not change the state; it sets
`data_quality: DEGRADED` and adds a reason code.

### 6.3 Transition table

| # | From | Trigger / guard | To | Recorded |
|---|---|---|---|---|
| T1 | `INITIALIZING` | every configured node `VALID` and `NORMAL` | `NORMAL` | state transition |
| T2 | `INITIALIZING` | `init_timeout_ms` elapsed, some node not `VALID`, no confirmed abnormality | `DEGRADED` | `NODE_OFFLINE` / `SENSOR_FAULT` events |
| T3 | `INITIALIZING`, `NORMAL`, `DEGRADED`, `TRANSIENT`, `UNDERVOLTAGE` | ≥1 node `SUPPLY_LOST` and localization ≠ `INCONSISTENT` | `INTERRUPTION_SUSPECTED` | open `INTERRUPTION_SUSPECTED` or `SOURCE_INTERRUPTION_SUSPECTED` (CRITICAL) with localization + snapshot; close any open `UNDERVOLTAGE` on the same nodes with end reason `ESCALATED` and link them |
| T3a | same as T3 | ≥1 node `SUPPLY_LOST` but localization `INCONSISTENT` | `DEGRADED` | `MEASUREMENT_INCONSISTENT` (WARNING) — not an interruption |
| T4 | `INITIALIZING`, `NORMAL`, `DEGRADED`, `TRANSIENT` | ≥1 node `UNDERVOLTAGE`, none `SUPPLY_LOST` | `UNDERVOLTAGE` | open `UNDERVOLTAGE` per node (WARNING) |
| T5 | `NORMAL`, `DEGRADED` | a node reports a transient | `TRANSIENT` | `TRANSIENT_DIP` (INFO), opened and closed together |
| T6 | `TRANSIENT` | `transient_display_hold_ms` elapsed, nothing else active | `NORMAL` / `DEGRADED` | state transition |
| T7 | `NORMAL` ↔ `DEGRADED` | any node not `VALID`, an `INCONSISTENT` pattern, or a node still `RECOVERING` with no incident open / none of these | `DEGRADED` / `NORMAL` | open/close `NODE_OFFLINE`, `SENSOR_FAULT` per node |
| T8 | any except `UNKNOWN` | controller reports `isolation_commanded = true` | `ISOLATION_PENDING` | timeline `ISOLATION_REQUESTED`; event `isolation_requested = true`; localization frozen. If no incident is open (controller tripped before the server confirmed anything), open `INTERRUPTION_SUSPECTED` with reason `PROTECTION_TRIP_REPORTED` and the controller's `trip_reason` |
| T9 | `ISOLATION_PENDING` | switch feedback `OPEN` | `ISOLATED` | timeline `ISOLATION_CONFIRMED`; `isolation_confirmed = CONFIRMED` |
| T10 | `ISOLATION_PENDING` | feedback fitted, not `OPEN` after `isolation_feedback_timeout_ms` | stays `ISOLATION_PENDING`, feedback state `TIMEOUT` | open `ISOLATION_UNCONFIRMED` (CRITICAL); closed if `OPEN` arrives later (then T9) |
| T11 | `ISOLATION_PENDING` | feedback `NOT_FITTED` | stays `ISOLATION_PENDING` (label *"Isolation commanded — not confirmed"*) | `isolation_confirmed = NO_FEEDBACK_FITTED`. **Never shown as `ISOLATED`.** |
| T12 | `ISOLATED`, `ISOLATION_PENDING` | feedback `CLOSED` while still commanded, or `OPEN` while not commanded | `ISOLATION_PENDING`, feedback state `CONTRADICTORY` | open `ISOLATION_FEEDBACK_CONTRADICTORY` (CRITICAL). An *uncommanded* `OPEN` is also added as a possible cause of downstream loss. |
| T13 | `ISOLATED`, `ISOLATION_PENDING` | controller `restore_requested = true` (switch still commanded open) | `RESTORATION_PENDING` | timeline `RESTORATION_REQUESTED` with `restore_source` |
| T14 | `RESTORATION_PENDING`, `ISOLATED`, `ISOLATION_PENDING` | `isolation_commanded = false` and feedback `CLOSED` (or `NOT_FITTED`) | `RECOVERY_CHECK` | timeline `RECLOSE_REPORTED`; localization unfrozen |
| T15 | `INTERRUPTION_SUSPECTED`, `UNDERVOLTAGE` | no isolation commanded; all affected nodes now `RECOVERING` or `NORMAL` | `RECOVERY_CHECK` | timeline `SUPPLY_RETURN_DETECTED` |
| T16 | `RECOVERY_CHECK`, `RESTORED` | any affected node falls back to `SUPPLY_LOST` / `UNDERVOLTAGE`; or after T14 the affected nodes do not regain supply within `reclose_supply_timeout_ms` | `INTERRUPTION_SUSPECTED` / `UNDERVOLTAGE` | **same event continues**; timeline `RECOVERY_UNSTABLE` or `RESTORATION_FAILED`; `unstable_recovery_count += 1` |
| T17 | `RECOVERY_CHECK` | controller re-commands isolation | `ISOLATION_PENDING` | as T8, same event |
| T18 | `RECOVERY_CHECK` | all nodes `NORMAL` (each passed its stability timer) and no isolation commanded | `RESTORED` | timeline `RECOVERY_STABLE` |
| T19 | `RECOVERY_CHECK` | affected nodes stable but controller still holds isolation (e.g. sensors upstream of an open switch after a source outage) | `RESTORATION_PENDING` | `recovery_state = STABLE_AWAITING_CONTROLLER` |
| T20 | `RESTORED` | `restored_hold_ms` elapsed with no abnormality | `NORMAL` / `DEGRADED` | close the event (§7.3) |
| T21 | any | every controller offline, or no node `VALID` | `UNKNOWN` | `CONTROLLER_COMM_LOST` (WARNING); open incident stays open with timeline `MONITORING_LOST`; **no event is closed while `UNKNOWN`** (missing data is not evidence that a condition cleared) |
| T22 | `UNKNOWN` | valid data resumes | if an incident is open, re-enter its phase from current data (e.g. supply present → `RECOVERY_CHECK`); else `INITIALIZING` | close `CONTROLLER_COMM_LOST`; timeline `MONITORING_RESUMED` |

Lifecycle summary (the happy path for a protected break):

```
NORMAL ─T3─► INTERRUPTION_SUSPECTED ─T8─► ISOLATION_PENDING ─T9─► ISOLATED
   ▲                                                               │ T13 (local reset / authorised request)
   │                                                               ▼
   └─T20── RESTORED ◄─T18── RECOVERY_CHECK ◄─T14── RESTORATION_PENDING
                              │   ▲
                         T16  ▼   │ supply returns again
                        INTERRUPTION_SUSPECTED (same event, unstable count +1)
```

### 6.4 Things that never cause an interruption claim

- a node going `STALE` / `OFFLINE` / `INVALID` (→ `DEGRADED`)
- all controllers going silent (→ `UNKNOWN`)
- a server restart or a database outage
- duplicate or late messages
- an inconsistent pattern (→ `DEGRADED` + `MEASUREMENT_INCONSISTENT`)

### 6.5 Protection agreement check

The server compares its own per-node supply judgement with the controller's
`supply_present`, and its feeder state with the controller's trip status. Disagreement
lasting `protection_disagreement_ms` opens `PROTECTION_DISAGREEMENT` (WARNING). This
usually means the firmware thresholds and `detection.json` differ, and is shown on the
diagnostics page. The server does not override the controller.

---

## 7. Layer E — event lifecycle

### 7.1 One open event per condition

Each event type has a **dedupe key**; at most one `OPEN` event per key, enforced in
SQLite by a unique partial index (`… WHERE status = 'OPEN'`).

| Event type | Dedupe key | Opens on | Closes on |
|---|---|---|---|
| `UNDERVOLTAGE` | `UV:<node>` | node → `UNDERVOLTAGE` | node stable `NORMAL` (via recovery) or escalation |
| `INTERRUPTION_SUSPECTED` / `SOURCE_INTERRUPTION_SUSPECTED` | `INT:<feeder>` | T3 or T8 | T20 |
| `TRANSIENT_DIP` | none (atomic) | transient output | same moment |
| `NODE_OFFLINE` | `OFFLINE:<node>` | validity `OFFLINE` | validity `VALID` |
| `SENSOR_FAULT` | `SENSOR:<node>` | validity `INVALID` for a sensor reason | validity `VALID` |
| `MEASUREMENT_INCONSISTENT` | `INCONS:<feeder>` | T3a | pattern consistent again |
| `CONTROLLER_COMM_LOST` | `COMM:<controller>` | controller offline | reports resume |
| `CONTROLLER_REBOOT` | none (atomic) | new `boot_id` | same moment |
| `SERVER_RESTART` | none (atomic) | server start with a previous run in the same database | same moment |
| `ISOLATION_UNCONFIRMED` | `ISOUNC:<switch>` | T10 | `OPEN` feedback or command released |
| `ISOLATION_FEEDBACK_CONTRADICTORY` | `CONTRA:<switch>` | T12 | consistent again |
| `PROTECTION_DISAGREEMENT` | `DISAGREE:<feeder>` | §6.5 | agreement restored |

Isolation requests, confirmations, reclose, unstable recovery and restoration are
**updates to the owning interruption event** (fields + timeline rows), so one incident
appears as one row in the history table.

### 7.2 Never per sample

Events are created only from *transitions* in layers A–D. A condition that persists for
an hour produces one event, not 3600. Duplicate and late reports never reach layers B–D,
so reconnect bursts cannot create events.

### 7.3 Closing and duration

- `start_timestamp` = when the condition was confirmed; `first_observed_timestamp` = the
  first abnormal sample (difference = persistence delay, shown for transparency).
- For interruption and undervoltage events, `end_timestamp` = **the start of the
  stability window that succeeded** (the moment supply returned and then stayed stable),
  not the moment the stability timer expired. The event is *closed* later (after
  `restored_hold_ms`); both moments are in the timeline.
- `duration_ms` = `end_timestamp − start_timestamp`, quoted with the report-interval
  resolution.

### 7.4 Server restart

On start, open events are loaded from the database. The in-memory pipeline starts in
`INITIALIZING`, and an atomic `SERVER_RESTART` event records the gap. As fresh data
arrives:
- if the condition is still present, the existing open event continues (no duplicate);
- if it has cleared, the event is closed with `end_timestamp_quality = "APPROXIMATE"`
  (the true end happened while the server was down) and a timeline note.

### 7.5 Transient rate limiting

Transients detected at several nodes in the same evaluation (e.g. a source-side dip seen
at every node) are grouped into **one** `TRANSIENT_DIP` event listing all those nodes.
At most `transient_max_events_per_min` such events per feeder per minute are recorded
individually; further dips in that minute increment a `suppressed_count` on the last
one, so a noisy supply cannot flood the history.

---

## 8. Scenario expectations (acceptance reference)

These are the repeatable simulator scenarios and what the software must produce. The
same scripts (`server/simulation/scenarios/*.json`, each with an `expect` block) drive the
automated tests. Nodes: `N-A → N-B → N-C`, sections `S-0A`, `S-AB`, `S-BC`, one
source-side switch `SW-1` de-energising all nodes.

The **virtual controller** (simulated firmware) trips when a node has no supply while its
upstream node has supply and every node below it also has none — the pattern of an
energised conductor ending at a break (assumption A14). It trips after its own
`trip_delay_ms`, which is shorter than the server's `loss_persistence_ms`, so in
protected scenarios the feeder goes straight from `NORMAL` to `ISOLATION_PENDING`
(T8): local protection acts before the supervisory system has confirmed anything. That
is the intended architecture. A source-wide loss (S05) is not a break pattern, so the
virtual controller does not trip and the unprotected path (T3 → T15 → T18) is shown.

| ID | Scenario | Expected feeder states | Localization | Events (exactly) |
|---|---|---|---|---|
| S01 | All normal | `INITIALIZING → NORMAL` | `NOT_APPLICABLE` | none |
| S02 | Sustained UV at N-C, then normal | `… NORMAL → UNDERVOLTAGE → RECOVERY_CHECK → RESTORED → NORMAL` | `NOT_APPLICABLE` | 1 × `UNDERVOLTAGE` (N-C), closed |
| S03 | Two brief source dips: one shorter than a report (visible only in `voltage_rms_min`), one longer | `… NORMAL → TRANSIENT → NORMAL → TRANSIENT → NORMAL` | — | 2 × `TRANSIENT_DIP` (each grouping all 3 nodes); no UV/interruption |
| S04 | Conductor parts in S-AB; controller isolates; feedback `OPEN` | `… NORMAL → ISOLATION_PENDING → ISOLATED` | `FROZEN` (from `LOCALIZED_ESTIMATE` S-AB) | 1 × `INTERRUPTION_SUSPECTED`, `isolation_confirmed = CONFIRMED` |
| S05 | Source supply lost (all nodes), then returns | `… NORMAL → INTERRUPTION_SUSPECTED → RECOVERY_CHECK → RESTORED → NORMAL` | `SOURCE_OR_UPSTREAM`, no section claimed | 1 × `SOURCE_INTERRUPTION_SUSPECTED`, closed |
| S06 | N-B sensor reports `SATURATED`, later clears | `… NORMAL → DEGRADED → NORMAL` | — | 1 × `SENSOR_FAULT` (N-B); no interruption |
| S07 | N-C stops appearing in reports, later returns | `… NORMAL → DEGRADED → NORMAL` | — | 1 × `NODE_OFFLINE` (N-C); no interruption |
| S08 | Break, isolation, repair + local reset, supply flickers twice, then holds | `… ISOLATED → RESTORATION_PENDING → RECOVERY_CHECK → INTERRUPTION_SUSPECTED → RECOVERY_CHECK → INTERRUPTION_SUSPECTED → RECOVERY_CHECK → RESTORED → NORMAL` | — | 1 interruption event, `unstable_recovery_count = 2`, closed |
| S09 | Break, isolation, repair + local reset, supply stable | `… ISOLATED → RESTORATION_PENDING → RECOVERY_CHECK → RESTORED → NORMAL` | — | 1 interruption event closed, `end_timestamp` = start of stable window |
| S10 | Break; isolation commanded but relay fails to open (feedback stays `CLOSED`) | `… NORMAL → ISOLATION_PENDING` (stays) | `FROZEN` | interruption event with `isolation_confirmed = NOT_CONFIRMED` + 1 × `ISOLATION_UNCONFIRMED`; **never `ISOLATED`** |
| S11 | Controller goes silent for 20 s (keeps protecting locally), then resumes | `… NORMAL → UNKNOWN → INITIALIZING → NORMAL` (UNKNOWN as soon as no node has fresh data — T21) | `INSUFFICIENT_DATA` while silent | 1 × `CONTROLLER_COMM_LOST`; no interruption, no `NODE_OFFLINE` |
| S12 | Link outage with buffering; on reconnect newest report first, then backlog + duplicates | `… NORMAL → UNKNOWN → INITIALIZING → NORMAL` | unchanged | no events; 5 rows flagged `LATE`, 2 duplicates ignored |
| S13 | N-B sensor reads ~0 V while reporting OK; N-C still has supply | `… NORMAL → DEGRADED → NORMAL` | `INCONSISTENT` | 1 × `MEASUREMENT_INCONSISTENT`; no interruption, no trip |
| S14 | Break; isolation commanded; **no feedback contact fitted** | `… NORMAL → ISOLATION_PENDING` (stays) | `FROZEN` | interruption event with `isolation_confirmed = NO_FEEDBACK_FITTED`; **never `ISOLATED`**; no `ISOLATION_UNCONFIRMED` |

Server restart during an incident is covered by an integration test (open event reloaded
and continued, no duplicate, `SERVER_RESTART` recorded) rather than a scenario file.

Timing values are not asserted as performance claims; tests assert the *sequence* and
the *count* of states and events under the virtual clock.
