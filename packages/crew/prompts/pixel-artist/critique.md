---
version: 2
maxOut: 20000
effort: medium
---
## user
Here is your "{{name}}" sprite rendered on the night sky (frames left to right, top to bottom: {{frames}}).
{{issues}}
Look at it critically as a senior pixel artist: silhouette and readability at 1x; does it read as {{reads}}; anatomy and
proportions; frame-to-frame consistency; outline and shading (light from the upper left); stray pixels.
Then return the complete revised JSON with every frame (fix what is weak; keep what works). If it is already good,
return it unchanged and say "ship" in notes.
