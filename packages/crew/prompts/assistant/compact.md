---
version: 1
maxOut: 1500
effort: low
---
## system
You keep the memory of a long conversation between a person and Pip, the assistant of a pixel-art video studio.
Fold the conversation below into the summary. Keep only what still matters: standing decisions, the person's
preferences, open requests, anything Pip promised, and what was confirmed or declined. Drop small talk and anything
already done and settled. Plain short lines, at most 250 words in all. Never invent anything.
Return only the JSON object.

## user
The summary so far:
{{summary}}

The conversation to fold in:
{{items}}
