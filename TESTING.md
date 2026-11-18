# Things to test by hand

A running list of checks that need you at the computer. Work through them
whenever is convenient; tick each box and note anything that looks wrong.
Newest items are at the bottom of each section.

**Before you start:** reload Clean Ears at `chrome://extensions` (circular
arrow) and check the version number shown matches the one below.

---

## Version 1.13.0 · roadmap steps 6–7 (swear spotter, allow-list)

- [ ] **Never filter.** The popup has a "Never filter" box with names like
      Moby Dick. On a video that says "Moby Dick", it isn't muted; a plain
      "dick" still is.
- [ ] **Who caught it.** Hover a word in the popup's caught list: the
      tooltip says whether Whisper, the swear spotter, or both caught it
      (both shows ✓✓).
- [ ] **Spotter catches more.** With the companion running, swears that
      Whisper mishears are still muted. Note any video where a normal word
      gets muted that shouldn't (a spotter false alarm) and what the word was.

## Version 1.12.0 · roadmap step 5.3 (tighter word cover)

- [ ] **Less cut around swears.** With the companion running, the words
      right before and after a swear are clipped much less than before
      (about 0.16 s extra in total instead of ~0.8 s).
- [ ] **Still the whole word.** No start or end of a swear is audible. If
      one is, raise "Word cover" in the popup a little and note the video.

## Version 1.11.0 · roadmap step 5.2 (exact word timings)

Re-run `companion/install.sh` once first: it downloads the alignment model
(~378 MB).

- [ ] **Whole words muted, nothing extra.** With the companion running, the
      start and end of each swear are silenced (no "s…" or "…t" leaking),
      and neighbouring words aren't clipped more than before.
- [ ] **Compare (optional).** `companion/start.sh --no-align` uses the old
      timing method, so you can hear the difference on the same video.

## Version 1.9.0 · roadmap step 4.4 (background clips for the mixer)

Nothing you can hear changes yet (step 12 will use the clips).

- [ ] **Still filters normally** with the companion running: no delay,
      swears muted, the popup's totals go up.
- [ ] **Voice stem from the start.** In the companion's Terminal, the
      per-minute line *served N windows (…, M from the separated voice)*:
      M should now be nearly all of N, even in the first minute of a video.

## Version 1.8.0 · roadmap step 4.3 (transcribing the separated voice)

- [ ] **Voice stem used.** With the companion running, play a video with
      music under the speech for a minute. The companion's Terminal prints
      *served N windows (… , M from the separated voice)*; M should be most
      of N after the first few seconds.
- [ ] **Swears under music.** On a video where someone swears over loud
      music, the swears are caught (compare with `companion/start.sh
      --asr-input mix` if you want to see the difference).

## Version 1.7.0 · roadmap step 4.2 (voice/music separation)

Start the companion so it saves a sample of what it separates:

```sh
CLEAN_EARS_DUMP_STEMS=~/Desktop/clean-ears-stems companion/start.sh
```

- [ ] **Stems keep up.** Play a YouTube video that has music under the
      speech (a vlog, a trailer) for a minute. The companion's Terminal window
      prints a line like *separated N blocks (… s of audio) in the last 60 s*.
- [ ] **Listen to the stems (optional).** After ~30 s of playback, the folder
      `~/Desktop/clean-ears-stems` has `01-vocals.wav`, `01-background.wav`
      and `01-mix.wav`. The vocals file should be mostly voices, the
      background mostly music and effects.
- [ ] **Nothing else changed.** Filtering, the no-delay label and swear
      muting behave as in 1.6.0.

## Version 1.6.0 · lifetime stats in the popup

- [ ] **Words blocked total.** Open the popup: the first box shows
      *N words blocked*. Play a video with swearing; each swear that's bleeped
      or silenced adds one, and a phrase ("son of a bitch") adds only one.
      The number updates while the popup is open and survives closing Chrome.
- [ ] **Days profanity free.** The box to its right shows *1 day profanity
      free* today and goes up by one each calendar day (it counts from when
      you first loaded 1.6.0).

## Version 1.5.1 · roadmap step 2.3 (companion setup)

Start the companion first (in Terminal, from the project folder):

```sh
companion/start.sh
```

- [ ] **Popup shows the companion.** Open the Clean Ears popup on any page.
      Under "Companion app" it should say *Running · Whisper small on GPU*.
- [ ] **Popup when it's off.** Quit the companion (Ctrl-C in Terminal) and
      reopen the popup. It should say *Not running* with instructions for
      starting it. Start it again; within ~3 s the popup should switch back to
      *Running*.
- [ ] **Normal video, no delay.** Play any video with swearing. The label on
      the video should read *Clean Ears on · no delay · companion app · N
      filtered*, and swears should be fully silenced/bleeped (none of the word
      audible, start or end).
- [ ] **Quit mid-video.** While a video plays, quit the companion. The video
      should keep playing with no pause and no delay; "companion app" drops off
      the label within a few seconds; swears after that point are still
      filtered.
- [ ] **Restart mid-video.** Start the companion again while the video plays;
      "companion app" should come back on the label within ~5 s.
- [ ] **Live stream.** Open any live news stream. Label: *… s delay (live
      stream)*. Speech is being filtered (the popup shows a time per pass —
      it should be about 1 s or less; it was 2.4 s before a fix in 1.5.1).
- [ ] **Less memory with the companion running.** In Chrome's Task Manager
      (⋮ → More tools → Task manager), the "Extension: Clean Ears" offscreen
      entry should stay small while the companion runs (the built-in model
      isn't loaded). After you quit the companion it grows (the built-in model
      loads as the fallback).
- [ ] **Start at login (optional).** `companion/login-item.sh on`, log out and
      back in, open the popup: *Running*. Turn it off again with
      `companion/login-item.sh off` if you don't want it.

## Version 1.3.0 · roadmap step 1.7 (edge cases not seen in automated tests)

- [ ] **Ads.** If an ad plays before or during a video, the filter keeps
      working through it and the video afterwards (label stays sensible).
- [ ] **Protected video.** A paid/rented YouTube film: label should read
      *… s delay (protected video)*.
