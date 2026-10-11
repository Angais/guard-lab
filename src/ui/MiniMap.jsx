import React from 'react';
import { ZONE_INFO } from './play.mjs';
import { Segmented } from './kit.jsx';

const PACE = {
  walk: 'Quieter, and safe on a wet floor.',
  run: 'Louder. Dodges close-range devices on G-01’s next turn, but slips on a wet floor.',
};

// A top-down plan of the room. North (the exit wall) is at the top, like the camera view.
// `wet` lists the zones whose floor is wet: a run that starts or ends on one slips.
export function MiniMap({ zone, disabled, onMove, run, onRun, wet = [] }) {
  const wetHere = wet.includes(zone);
  return (
    <div className="minimap">
      <div className="minimap-room" role="group" aria-label="Room map. Choose where to go.">
        <span className="map-door map-door-exit" aria-hidden="true" />
        <span className="map-door map-door-entrance" aria-hidden="true" />
        <span className="map-safe" aria-hidden="true" />
        <span className="map-robot" aria-hidden="true">
          G-01
        </span>
        {ZONE_INFO.map((z) => {
          const here = z.id === zone;
          const isWet = wet.includes(z.id);
          const slips = run && (wetHere || isWet);
          return (
            <button
              type="button"
              key={z.id}
              className={`map-zone ${here ? 'is-here' : ''} ${isWet ? 'is-wet' : ''}`}
              style={{ left: `${z.x}%`, top: `${z.y}%` }}
              disabled={disabled || here}
              aria-current={here ? 'location' : undefined}
              title={slips ? 'Wet floor: a run here slips' : undefined}
              aria-label={
                here
                  ? `${z.label} (you are here${isWet ? ', wet floor' : ''})`
                  : `${run ? 'Run' : 'Walk'} to ${z.label}${slips ? ' (wet floor: you would slip)' : ''}`
              }
              onClick={() => onMove(z.id)}
            >
              <span className="map-pin">{here ? '' : z.key}</span>
              <span className="map-label">
                {here ? 'You' : z.label}
                {isWet ? ' · wet' : ''}
              </span>
            </button>
          );
        })}
      </div>
      <div className="minimap-foot">
        <Segmented
          size="xs"
          label="Pace"
          value={run ? 'run' : 'walk'}
          onChange={(value) => onRun(value === 'run')}
          options={[
            { value: 'walk', label: 'Walk', title: PACE.walk },
            { value: 'run', label: 'Run', title: PACE.run },
          ]}
        />
        <span className="minimap-tip">Press 1–5</span>
      </div>
      <p className={`minimap-pace ${run && wetHere ? 'is-warn' : ''}`}>
        {run && wetHere
          ? 'The floor here is wet: a run slips. Walk instead.'
          : PACE[run ? 'run' : 'walk']}
      </p>
    </div>
  );
}
