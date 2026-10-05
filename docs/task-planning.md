# Creation-time work planning

One existing project board remains the source of truth. Work category, execution stage,
blocked reason, urgency and the node's board column are independent dimensions. This
feature does not create columns, move cards, sort the board, launch sessions or adopt
creator authority. Canvas groups and `parentId` keep their geometry meaning.

Every newly created terminal/agent node records `taskPlanning` before persistence and
launch. Assistant creation uses the existing immutable task/creation envelope and private
creator receipt; its optional `creation.planning` declaration supplies explicit intent.
Historical envelopes remain readable. Missing declarations are completed from explicit
functional-role metadata: known roles receive a stable category, and an unknown role or
manual launch receives `needs-classification` with an explanation. The card modal's
Category control resolves that queue without moving the card. Models and titles never
classify work, urgency or parent relationships.

Categories are `implementation`, `design`, `research`, `operations`, `security`, `release`,
`customer`, `data`, `coordination` and the unresolved `needs-classification` queue. The
board filter and badges expose this complete vocabulary without renaming existing columns.
An explicit category is preferred to the role fallback. User category and priority choices
remain board metadata overrides. An explicit priority clear is retained as a tombstone.

## Shared declaration

The same object is suitable for a task coordinator, a standalone work item or a supporting
session. Deliverables and Notion links are optional; work does not require an artifact.

```json
{
  "version": 1,
  "taskId": "evidence-task-0001",
  "category": "research",
  "categoryReason": "Collect the explicitly requested release evidence",
  "relationship": "support",
  "parentTaskId": "release-task-0001",
  "urgency": {
    "mode": "auto",
    "level": "medium",
    "reason": "Routine work; no verified time-sensitive evidence supplied.",
    "signals": [
      { "kind": "dependency-unblock", "evidence": "Unblocks the named release acceptance gate" }
    ]
  }
}
```

`relationship` is `independent` by default. `support` requires an exact, distinct
`parentTaskId`. Optional fields are `stage` (`planned`, `active`, `review`, `done`),
`blockedReason` and an HTTPS `deliverableUrl`. Intent is descriptive content, not permission
to message, resume, clean up or control a parent or child session.

Urgency reuses the existing `low`, `medium`, `high`, `urgent` vocabulary. Every assessment
records a reason and up to 16 structured evidence signals. No evidence means an explained
routine `medium`, not urgent. A recorded user priority or `mode:manual` overrides computed
pressure. Other signals are evaluated deterministically:

- An explicit deadline or customer launch within 24 hours is urgent; within three days is high.
- A verified live privacy/security incident is urgent. A security category alone is insufficient.
- Dependency unblock and paid-spend risk are high. These require explicit evidence.
- Verified stalled age of at least seven days is high; age never promotes work to urgent.

Time signals carry an epoch-millisecond `at`; user priority carries `priority`. Every signal
has `evidence`. Blocked status never lowers urgency. Read-time reassessment changes badges,
not persisted order or assignments. Creation fingerprints bind original declarations;
clock-dependent assessment is performed on first creation, so an exact retry cannot change
identity at a deadline threshold.

## Visibility and preservation

Only an explicit supporting relationship with exactly one present independent parent on
the same board folds by default. The parent's expandable list opens each child's existing
card/session. The complete session collection, saved nodes and history remain available;
no canvas node, terminal subscription or provider process is deleted or restarted.
Missing, ambiguous, cyclic or invalid parent declarations remain visible. Independent
work remains visible. Pins, manual geometry and manual board assignment tombstones keep
supporting cards visible. A support category filter retains the parent that contains it.
Duplication gets a new independent unresolved task; imports cannot inherit creator intent.

## API and caller boundary

`POST /opsapi/nodes` accepts planning within `creation.planning`, with the same task ID as
the envelope. Server Edition verified headless creation accepts `--task-planning` JSON alongside
the existing task/creation/organization flags. Category, urgency and parent intent are
durable before the external launch. Invalid planning rejects before save or spawn.

`PATCH /opsapi/nodes/<id>` accepts `{taskPlanning, expectedRevision}` alone. It requires
private creator evidence for an operator-created assistant worker, binds task identity to the
immutable creation receipt found through the private owner and journal, refuses
stale revisions even with `force=1`, and changes descriptive node metadata only. It leaves
manual board priorities, category overrides, placements, pins, order and geometry intact.
Uncertain writes return `task_planning_write_uncertain_reload_before_retry`; reload and
inspect before deciding whether to retry. No bulk backfill endpoint is introduced.

The paired Fern helper accepts `--task-planning-file` (UTF-8 JSON, at most 16 KiB). Its
authenticated creation-contract read requires the planning-before-save-and-spawn promise;
an older server refuses before POST. The repository organization client uses the same
contract. Review and activate server/helper/guide compatibility together; this document
does not authorize installation, a live upgrade or an existing-board mutation.

Backfill is an explicit, bounded allowlist of active assistant-created IDs with private
creator/source evidence. Establish task, category and urgency evidence first; inspect current
manual choices, then use a fresh revision for each metadata-only update. Never infer a
parent or adopt ownership from names, a generic operator label, or an old snapshot.

Desktop and Server Edition share planning codecs, assessment and renderer behavior. Manual
desktop/browser creation records explained unresolved defaults before launch. The desktop
canvas-control route does not admit explicit assistant planning or parent declarations;
it rejects `--task-planning` before dispatch. Use the managed Server API for those declarations.
Other providers' task/session creation
outside NodeTerm is a coordinator responsibility, not intercepted by this source change.
@eneskirca: the mobile companion should preserve the new metadata, show category and urgency
reason separately from stage/blocked state, honor manual overrides, and fold only explicit
support links while retaining an expandable route to the same sessions. Native SwiftUI
behavior is outside this repository and remains unverified.
