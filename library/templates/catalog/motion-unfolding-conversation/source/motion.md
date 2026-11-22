# An unfolding conversation device — motion specification

## Intent and editable inputs

A portrait device rises into the frame, turns and unfolds into a two-pane landscape layout: a
topic list stays on the left while a live conversation fills the right pane. The same
conversation continues when the device folds back to portrait and while the folded device shows
its recording waveform, before the brand page closes the film.

Replace the tagline, session title, brand name, corner note, accent and background colors while
preserving the sequence: portrait rise, unfold, list/detail interaction, full-bleed phrase, fold
back with state kept, folded recording waveform, brand page.

The reference implementation is `preview.html` and the registered editable project
(`index.html` + `compositions/film.html`); the canvas is 720 × 900 at 60 fps, 17.02 seconds,
silent. Audio is intentionally absent; add a music bed only when your brief asks for one.

## Visual system

- Background: snow paper `#F5F8FB` with a dotted 26 px grid; ink text `#1E252C`; secondary text
  `#56626D`.
- Surfaces: pale blue `#DCE8F2` / `#E8EFF5` / `#E3ECF4`, soft green `#DCE5DC`, warm sand
  `#F2E1D0`; cool blue accent `#8FA7BB`; copper accent `#A8714A` with the spark gradient
  `#E8B381 → #A8714A`.
- Furniture: paper collage pieces at the canvas edges (never over the device), two hand-drawn
  ink arrows (top-left solid, bottom-right dashed) and a serif corner note.
- Device: one morphing frame, dark `#1B2026`, radius 40 (portrait) → 26 (wide), which grows
  230 × 440 → 660 × 370 around the canvas center. The fold line shows during the unfold.
- Portrait screen: wordmark header with feather, serif session title, mascot orb in the sleeping
  state (matching the "Wake me up" status), status pill, mic pill and a secondary
  "Type a reply" line.
- Wide screen: left pane (37%, pale blue) with eyebrow, serif title, category chips and five
  topic rows (one selected with a copper ring); right pane with the mascot orb in the
  speaking state (open beak), conversation bubbles
  (alternating white / ink), italic serif translation lines, a word chip with recall dots, a
  typing indicator and a reply field with a copper mic.
- Phrase stage: full-bleed Newsreader serif, 62 px, centered, plain ink.
- Tent stage: two dark panels leaning ±7° from their bottom edge, copper gradient edge lights,
  serif clock, session title, "Listening" pill, live conversation title, waveform bars in the
  copper gradient, transport buttons and a timecode.
- Brand stage: solid accent background, spark, white mascot orb in the idle state, serif
  wordmark with the spark
  as the dot of the i, italic serif tagline, domain line.
- Typography: Newsreader (serif, weights 400/500/600 plus italic 400) and Schibsted Grotesk
  (sans, weights 400–700). The bundled subsets cover Latin and Latin-ext only; other scripts
  need a system fallback.

## Timing

| Time | Event | Rule |
| --- | --- | --- |
| 0.00–1.70 s | Portrait device rises | Enter from below the canvas, `expo.out`; screen elements stagger in. |
| 2.50–4.40 s | Unfold to two panes | Width and height morph with `power3.inOut`; portrait screen blurs out, fold line flashes, wide screen blurs in. |
| 4.50–7.50 s | List and conversation act | Chips and rows stagger; bubbles enter with 4 px blur, translations follow each bubble; the orb bobs once when it speaks; typing indicator closes the beat. |
| 7.85–8.05 s | Device exits | Blur out with a slight scale-down; the phrase stage covers the frame. |
| 8.18–10.30 s | Full-bleed phrase | One serif line blurs in, holds at least 2 s, blurs out. |
| 10.45–11.70 s | Fold back, state kept | The wide device returns and folds to portrait; the conversation state stays on the screen. |
| 12.00–13.55 s | Folded recording | Tent panels settle ±7°; waveform bars pulse on deterministic sine tweens; transport and timecode appear. |
| 13.60–17.02 s | Brand page | Spark pops, bird and wordmark rise in, tagline and domain settle; hold the closing message at least 2 s. |

All arrivals land on long ease-outs; exits are 40–60% shorter than entrances. Every visible
change is a function of the GSAP timeline time, so any frame renders identically when seeked.

## Adaptation

- Text nodes carry IDs (`film-tagline`, `ptTitle`, `ttitle`, `film-corner`, and the bubble and
  row nodes); the root declares Studio variables `accent`, `background`, `brandName`, `tagline`,
  `learnTitle` and `cornerNote`.
- Keep the list on one side and the detail on the other while the device is wide, and carry the
  same conversation through the portrait and folded stages.
- Design fold geometry and screen response together when adapting to another device: change the
  portrait and wide frame sizes in both morph tweens at once.
- UI text is intentionally set at phone-mock scale (10.5–13 px on this canvas); the type floor
  of a 720 × 900 canvas does not apply to simulated device UI.
- The brand stage assumes a light-on-accent wordmark; recolor `#brandDomain` and `#brandBy` if
  you move to a dark accent so contrast stays at 4.5:1 or better.

## Review

Play the complete 17 seconds and inspect the risen portrait at 1.8 s, the unfolded panes at
6.5 s, the phrase at 9.5 s, the tent at 12.9 s and the brand hold at 16.8 s. Check that no
collage piece covers the device, the conversation stays legible in both aspect ratios, and the
closing message holds. Technical checks and the registered export do not establish human visual
acceptance.

## Provenance and license

- The motion structure is an independent adaptation of the public Granola reference "An
  unfolding device changes the note layout" (source: <https://x.com/meetgranola/status/2113631820277592536>,
  catalog reference V138). No Granola footage, screenshots, logos or audio are included.
- The sample content — name, mascot orb, wordmark spark, palette, screens and copy — is the
  contributor's own product (Snowi by Safe4ai) and is included as replaceable sample content.
- Fonts: Newsreader and Schibsted Grotesk, SIL Open Font License 1.1; the license files ship
  beside the subset TTF files in `assets/fonts/`. GSAP is bundled under its own MIT license.
- HTML, CSS, JavaScript and motion rules are contributed under the repository's Apache-2.0
  license. The silent WebM rendition and JPEG poster derive from the registered editable
  project; their exact identities are recorded in `manifest.json` and, after maintainer
  preparation, `template.json.remoteAssets`.

## Reference playback

[Download the silent preview](assets/lfs/preview.webm) — a 360 × 450 WebM rendition of the full
17.02 s composition. The [offline interactive preview](preview.html) plays the same
deterministic timeline with play, replay and scrub controls.
