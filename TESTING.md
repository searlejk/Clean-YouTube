# Things to test by hand

A running list of checks that need you at the computer. Work through them
whenever is convenient; tick each box and note anything that looks wrong.
Newest items are at the bottom of each section.

**Before you start:** reload Clean Ears at `chrome://extensions` (circular
arrow) and check the version number shown matches the one below.

---

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
