# Heart-rate zones

## The method
Five zones as a share of heart-rate reserve (Karvonen):
`bpm = rest + pct × (max − rest)`. `HR_ZONES` + `hrZoneBpm` (`src/utils/hr.ts`)
are the one definition; every consumer reads them: plan session targets
(`SESSION_ZONES` → `sessionHR`), guided-workout HR targets (`zoneBpm`), the
recorders' live readout (`LiveHrZone`), time-in-zone (`timeInZones`), Progress →
Stats, and the coach's run digest (`runDigest.mjs` ports the bands; keep both
in sync).

| Zone | % of reserve | Plan sessions |
|------|--------------|---------------|
| Z1 Recovery | 50–60 | WALK |
| Z2 Aerobic Base | 60–70 | EASY, LONG, OTHER |
| Z3 Aerobic Tempo | 70–80 | TEMPO / RACE (lower half of their span) |
| Z4 Threshold | 80–90 | TEMPO / RACE, INTERVALS |
| Z5 VO2 Max | 90–100 | INTERVALS |

Inputs: `settings.maxHR` (blank → Tanaka `208 − 0.7 × age` from `birthYear`,
via `effectiveMaxHR`), `settings.restHR` (blank → 60).

## What the bands are, and aren't
A population formula, not a measured threshold. Z2's 70% ceiling is the cautious
end of where aerobic threshold (LT1/VT1) sits: trained runners commonly hit it
nearer 75–80% of reserve, which is why a lactate-threshold-based zone set (Friel,
or a watch's threshold test) usually puts the top of Z2 several bpm higher than
ours. Plain %-of-max apps put it lower. The explainer's copy says exactly this
and must not claim more precision than the formula has.

The HR race prediction reads threshold as 88–90% of reserve
(`docs/race-predictions.md`), not a zone boundary.

## Where it's explained
`HrZonesInfoBody` (`src/components/HrZonesInfo.tsx`) works the formula through
on the runner's own profile. It opens from the info link on Training profile's
heart-rate section and on the Stats zones card, and is a Help & FAQ topic. It
renders the bands from `HR_ZONES`, so a change to the bands updates it; its
prose (the Z2 ceiling, the "other apps" comparison) does not, so revisit it.
