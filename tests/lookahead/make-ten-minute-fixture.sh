#!/bin/bash
# Builds tests/lookahead/fixtures/ten-minutes.webm (+ ten-minutes.txt): ~10 min
# of synthetic speech (macOS `say`) as YouTube-like WebM/Opus 128 kb/s stereo.
# Used by transcribe-test.html (roadmap step 1.4). Not committed (~10 MB).
set -euo pipefail
cd "$(dirname "$0")/fixtures"
python3 - <<'PY'
import random
random.seed(7)
subjects = ["The weather report", "My neighbor", "The football coach", "Our science teacher", "The delivery driver", "That new restaurant", "The city council", "My older brother", "The library", "This old computer"]
verbs = ["said that", "announced that", "complained that", "explained that", "claimed that", "warned us that"]
objects = ["the bridge will close on Tuesday", "the shipment is three days late", "we should bring umbrellas tomorrow", "the game starts at seven thirty", "the printer is out of paper again", "dinner will be served at six", "the train was delayed by an hour", "the garden needs more water", "the meeting moved to Friday", "the battery lasts about ten hours"]
extras = ["Honestly, that is damn annoying.", "Well, holy shit.", "What the hell is going on?", "That is pretty good news.", "Nobody saw that coming.", "Let's just wait and see."]
lines = []
for i in range(1, 200):
    lines.append(f"Number {i}. {random.choice(subjects)} {random.choice(verbs)} {random.choice(objects)}. {random.choice(extras)}")
open("ten-minutes.txt", "w").write("\n".join(lines) + "\n")
PY
say -r 180 -f ten-minutes.txt -o /tmp/ten-minutes.aiff
ffmpeg -loglevel error -y -i /tmp/ten-minutes.aiff -t 600 -ar 48000 -ac 2 -c:a libopus -b:a 128k -f webm -cluster_time_limit 5000 ten-minutes.webm
rm -f /tmp/ten-minutes.aiff
ffprobe -v error -show_entries format=duration -of csv=p=0 ten-minutes.webm
