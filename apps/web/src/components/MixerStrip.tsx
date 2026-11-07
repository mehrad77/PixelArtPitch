// One bus of the mix (voice, SFX, music): its gain in dB on a native range, committed as a patch on release.
import { HudMeter } from "@shabboo/kit/react";
import { useEffect, useState } from "react";
import "./MixerStrip.css";

export function MixerStrip({
  id,
  label,
  db,
  min = -40,
  max = 0,
  onCommit,
  note,
}: {
  id: string;
  label: string;
  db: number;
  min?: number;
  max?: number;
  onCommit?: (db: number) => void;
  note?: string;
}) {
  const [v, setV] = useState(db);
  useEffect(() => setV(db), [db]);
  const level = Math.round(((v - min) / (max - min)) * 100);
  return (
    <div className="mixer-strip">
      <HudMeter
        label={label}
        value={level}
        min={0}
        max={100}
        segments={12}
        zones
        orientation="vertical"
        size="sm"
        valueText={`${v} dB`}
      />
      <label className="mixer-fader" htmlFor={id}>
        <span className="visually-hidden">{label} gain</span>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={0.5}
          value={v}
          disabled={!onCommit}
          aria-valuetext={`${v} decibels`}
          onChange={(e) => setV(Number(e.currentTarget.value))}
          onPointerUp={() => v !== db && onCommit?.(v)}
          onKeyUp={() => v !== db && onCommit?.(v)}
        />
      </label>
      <output htmlFor={id} className="mono small">
        {v} dB
      </output>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}
