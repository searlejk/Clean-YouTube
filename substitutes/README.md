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

Next: tune `map.json` on the train sentences, check it on the validation
ones, then use it in the extension instead of the fixed `FUNNY_WORDS` /
`FUNNY_PHRASES` lists.
