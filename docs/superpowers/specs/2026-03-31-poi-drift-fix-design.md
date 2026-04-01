# Fix False POI Transitions from GPS Drift

**Date:** 2026-03-31
**Status:** Approved

## Problem

Overnight GPS drift causes false "Left Home" Discord notifications. The phone's GPS intermittently drifts to a phantom location ~257m from home with accuracy values (20-26m) that pass the 30m filter. Two compounding issues allow this to trigger false transitions:

1. **Filtered points don't reset pending transitions.** When a point is filtered by accuracy (`acc > max_accuracy_m`), `server.js` returns early without calling `detector.detect()`. The POI detector's `pendingLocation`/`pendingCount` state persists, so scattered bad readings separated by filtered points accumulate toward `min_transition_points`.

2. **No time span requirement.** Three consecutive drift points ~30 seconds apart can trigger a transition in ~1 minute, even though GPS drift is typically brief and intermittent.

## Fix 1: Reset Pending Counter on Filtered Points

When a point is filtered by accuracy in `server.js`, call a new `detector.resetPending()` method to clear the pending transition state.

**New method in `poi.js`:**

```js
resetPending() {
  pendingLocation = null;
  pendingCount = 0;
  pendingStartTime = null;
}
```

**Change in `server.js`:** In the accuracy filter block (before the early return), call `detector.resetPending()`.

## Fix 2: Minimum Time Span for POI Transitions

Track when the first pending point arrived. Only trigger the transition when `pendingCount >= min_transition_points` AND the elapsed time from the first pending point to the current point exceeds `min_transition_seconds`.

**New config field:** `min_transition_seconds` in the `poi` section of `config.yml`, defaulting to 300 (5 minutes).

**Changes to `poi.js`:**

- Add `pendingStartTime` state variable (epoch seconds)
- Set it when `pendingCount` becomes 1 (first divergent point)
- Reset it alongside `pendingCount` (in `resetPending()` and when `current === lastLocation`)
- Add time span check: transition only fires when `pendingCount >= min_transition_points` AND `currentTimestamp - pendingStartTime >= min_transition_seconds`

**The `detect()` method needs a timestamp parameter** to support the time span check. Update signature to `detect(lat, lon, tst)` where `tst` is the entry's epoch timestamp.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/poi.js` | Add `resetPending()`, `pendingStartTime`, time span check, `tst` param to `detect()` |
| `src/server.js` | Call `detector.resetPending()` in accuracy filter; pass `entry.tst` to `detector.detect()` |
| `config.yml` | Add `min_transition_seconds: 300` to `poi` section |
| `test/poi.test.js` | Update tests for new `tst` parameter and new behaviors |

## What Stays the Same

- `min_transition_points: 3` still required (count AND time must both be met)
- Exit hysteresis (`exit_extra_m`) unchanged
- Visit detection and activity detection unchanged
- Discord notification format unchanged
