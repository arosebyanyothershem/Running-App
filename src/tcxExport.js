// Generate Garmin-compatible TCX structured workout files
// Garmin Connect and Coros accept TCX workout imports
// After running, the watch auto-syncs to Strava

function paceToSpeedMps(secPerMile) {
  // mps = 1609.34 meters / (secPerMile seconds)
  return 1609.34 / secPerMile;
}

function escapeXML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build a TCX structured workout for a sub-T interval session.
 * Format: warm-up (1 mi easy) → [reps × (interval + recovery)] → cool-down (1 mi easy)
 */
export function buildTCXForSubT(session, easyPace) {
  const { structured } = session;
  if (!structured) return null;

  const { reps, distM, recoverySec, paceLow, paceHigh } = structured;
  const midPace = (paceLow + paceHigh) / 2;
  const speedMps = paceToSpeedMps(midPace);
  const easySpeedMps = paceToSpeedMps((easyPace.low + easyPace.high) / 2);

  const name = `SubT ${reps}x${distM === 1609 ? '1mi' : (distM / 1000) + 'km'}`;

  // Build the steps
  const steps = [];
  let stepNum = 1;

  // Warm-up: 1 mile easy
  steps.push(`
      <Step xsi:type="Step_t">
        <StepId>${stepNum++}</StepId>
        <Name>Warm-up</Name>
        <Duration xsi:type="Distance_t">
          <Meters>1609</Meters>
        </Duration>
        <Intensity>Active</Intensity>
        <Target xsi:type="Speed_t">
          <SpeedZone xsi:type="CustomSpeedZone_t">
            <LowInMetersPerSecond>${(easySpeedMps * 0.9).toFixed(2)}</LowInMetersPerSecond>
            <HighInMetersPerSecond>${(easySpeedMps * 1.1).toFixed(2)}</HighInMetersPerSecond>
          </SpeedZone>
        </Target>
      </Step>`);

  // Repeat step (nested structure)
  const innerSteps = [];
  innerSteps.push(`
        <Step xsi:type="Step_t">
          <StepId>${stepNum++}</StepId>
          <Name>SubT interval</Name>
          <Duration xsi:type="Distance_t">
            <Meters>${distM}</Meters>
          </Duration>
          <Intensity>Active</Intensity>
          <Target xsi:type="Speed_t">
            <SpeedZone xsi:type="CustomSpeedZone_t">
              <LowInMetersPerSecond>${paceToSpeedMps(paceHigh).toFixed(2)}</LowInMetersPerSecond>
              <HighInMetersPerSecond>${paceToSpeedMps(paceLow).toFixed(2)}</HighInMetersPerSecond>
            </SpeedZone>
          </Target>
        </Step>`);
  innerSteps.push(`
        <Step xsi:type="Step_t">
          <StepId>${stepNum++}</StepId>
          <Name>Recovery jog</Name>
          <Duration xsi:type="Time_t">
            <Seconds>${recoverySec}</Seconds>
          </Duration>
          <Intensity>Resting</Intensity>
          <Target xsi:type="None_t" />
        </Step>`);

  steps.push(`
      <Step xsi:type="Repeat_t">
        <StepId>${stepNum++}</StepId>
        <Repetitions>${reps}</Repetitions>
        <Child>${innerSteps.join('')}
        </Child>
      </Step>`);

  // Cool-down
  steps.push(`
      <Step xsi:type="Step_t">
        <StepId>${stepNum++}</StepId>
        <Name>Cool-down</Name>
        <Duration xsi:type="Distance_t">
          <Meters>1609</Meters>
        </Duration>
        <Intensity>Active</Intensity>
        <Target xsi:type="Speed_t">
          <SpeedZone xsi:type="CustomSpeedZone_t">
            <LowInMetersPerSecond>${(easySpeedMps * 0.9).toFixed(2)}</LowInMetersPerSecond>
            <HighInMetersPerSecond>${(easySpeedMps * 1.1).toFixed(2)}</HighInMetersPerSecond>
          </SpeedZone>
        </Target>
      </Step>`);

  const tcx = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Workouts>
    <Workout Sport="Running">
      <Name>${escapeXML(name)}</Name>${steps.join('')}
    </Workout>
  </Workouts>
</TrainingCenterDatabase>`;

  return { name, tcx };
}

export function downloadTCX(session, easyPace) {
  const result = buildTCXForSubT(session, easyPace);
  if (!result) return false;
  const blob = new Blob([result.tcx], { type: 'application/vnd.garmin.tcx+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${result.name.replace(/\s+/g, '_')}.tcx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 100);
  return true;
}
