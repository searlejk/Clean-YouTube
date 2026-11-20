# Substitute swears by meaning

The same swear means different things: "fuck off" (go away), "fuck yeah"
(celebration), "so fucking good" (emphasis), "oh fuck" (dismay). Each needs a
different stand-in, and none of them should be a tired "frick".

- `senses.json`: every way each swear is used (its *sense*), with stand-ins
  for it, **shortest first**. The filter uses the longest stand-in that fits
  the time it has, so "guacamole" comes out only when there's room.
- `generate.py`: makes labelled example sentences for every sense with a
  small local language model (Qwen3-4B, 4-bit, on the Mac GPU; free and
  offline, no API tokens). Contexts (gamers, cooks, podcasts, comments…) are
  varied so the sentences sound like YouTube and the internet.
- `map.json` + `sense.js`: the simple map used at run time (no model): rules
  on the words next to the swear ("S off", "holy S", "the S out of", "my S" …)
  pick its sense; then `pick(sense, seconds, swear, wordBefore)` gives the
  stand-in, with the swear's ending ("goof{}" → goofing / goofed) and without
  repeating the word before it ("oh" + "oh snap" → "snap").
- `fit.js`: fits the stand-in into the time around the swear the way it's
  done by hand in the editor: the free time is from the end of the word
  before to the start of the word after; the longest stand-in that fits there
  at its natural pace is used (else the shortest, sped up at most 1.35×); it's
  placed over the swear, moved into the pause before if it would run into the
  next word, and given exactly the time it needs. Rules can swap words around
  the swear too ("what the fuck's going on" → "what is going on"). The editor
  runs it when a swear is opened, then again with the word's real length once
  it's made.
- `evaluate.js`: how often the map picks the right sense on the sentences
  (`node substitutes/evaluate.js --split val --errors 20`).
- `data/sentences.jsonl`: the sentences, each `{"sense", "text", "context",
  "split"}`; `split` is a stable 85 % train / 15 % validation split.

```bash
companion/.venv/bin/python substitutes/generate.py --per-sense 100
```

The generator asks for each sense in a random setting and style, then has
the model check each sentence's meaning against the sense and three others,
and keeps only the ones it agrees on (about half). ~4 s per kept sentence.

The set: 3,684 sentences, 60 for each of the 61 meanings (3,147 train / 527
validation). The map picks the right meaning for 83 % of the train sentences
and 81 % of the held-back validation ones. Part of what's left is wrong labels
in the generated set; part is meanings the next words can't tell apart (a
bare "f***!" can be joy or dismay).

Next: use the map in the extension instead of the fixed `FUNNY_WORDS` /
`FUNNY_PHRASES` lists.
