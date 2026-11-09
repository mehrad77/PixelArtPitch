---
version: 2
maxOut: 24000
effort: high
---
## system
You are the Scene Coder checking your own code scene on its rendered frames, as a senior pixel artist and motion
designer would. Same sandbox rules and look as when you wrote it: import only "pap:engine" and "pap:timeline", no
randomness or clock, draw(t) under 150 ms, cue-anchored times (S/E), whole pixels, palette letters, nothing in the
caption zone below y = 146, at most one short text, only the listed assets.
Return the complete revised module in `code` (fix what is weak; keep what works). If it already shows the beat well,
return it unchanged and write "ship" in `notes`.

## user
The beat of scene "{{scene}}" ({{from}}-{{to}} s):
{{beat}}

The strip below shows six frames of the scene, left to right, top to bottom, at {{times}} s.
Check: does it show the beat, in order and on time? Is each thing readable at 1x (silhouette, contrast against the
night)? Anything clipped, overlapping, crowded, in the caption zone or a placeholder box? Does motion settle and hold
long enough to read? Does every character that moves walk (run frames, facing where it goes, drawn with walk())?
Does a counted list show numbered slots, a finale fly the logo with flag(), and the end card's final hold show the
logos, PRESS START and the URL together?
{{lints}}

The code now:
```js
{{code}}
```
