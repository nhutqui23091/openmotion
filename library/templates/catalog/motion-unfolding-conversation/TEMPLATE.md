# An unfolding conversation device

A 17-second product-launch motion recipe: a portrait phone rises into the frame, turns and
unfolds into a two-pane layout (topic list on the left, live conversation on the right), closes
on a full-bleed serif phrase, folds back with the conversation kept, shows the folded device
recording a live voice waveform, and ends on a solid brand page with the wordmark, spark and
orb mascot.

## Use this template

1. Read [the motion specification](source/motion.md).
2. Open [the offline interactive preview](source/preview.html). It runs in a browser with no
   build step or network access; play, pause, replay or scrub the deterministic timeline.
3. Adapt the registered editable project (`source/index.html` + `source/compositions/film.html`)
   with the connected OpenMotion Agent: replace the variables and text nodes, keep the stage
   order and hold lengths, and re-render.
4. Keep the list on one pane and the conversation on the other while the device is wide, carry
   the same conversation through the portrait and folded stages, and hold the phrase and closing
   message for at least two seconds each.

## Editable inputs

- Tagline: `Learn a language by talking.` (phrase stage and brand page), up to 60 characters.
- Brand name: `Snowi` (portrait header and brand wordmark), up to 20 characters.
- Session title: `Speak Serbian with Snowi` (portrait, tent stage), up to 48 characters.
- Corner note: `snowi.site` (serif corner note), up to 30 characters.
- Accent: `#A8714A` (brand page, chips, mic, waveform) and background `#F5F8FB` via the root
  variables; conversation, topic and translation copy are plain text nodes in the scene.
- Canvas: 720 × 900 at 60 fps, 17.02 seconds, silent. Device UI text is intentionally set at
  phone-mock scale (10.5–13 px on this canvas).

## Status

This entry registers a verified editable HyperFrames project (`template.json.entry.files`,
including `index.html`). The project renders and exports through Studio; the registered silent
WebM and JPEG poster are renditions of that verified export. Human visual acceptance and
native-Studio template-copy verification remain open, as for all catalog contributions.

## Source and rights

- Motion structure: an independent adaptation of the public Granola reference "An unfolding
  device changes the note layout" ([original post](https://x.com/meetgranola/status/2113631820277592536),
  catalog reference V138). No Granola footage, screenshots, logos, fonts or audio are included.
- Sample content: name, orb mascot (brand v1.2), wordmark spark, palette, screens and copy belong to the
  contributor's own product (Snowi by Safe4ai) and are included as replaceable sample content.
- Fonts: Newsreader and Schibsted Grotesk under the SIL Open Font License 1.1, shipped as
  Latin/Latin-ext static subsets beside their license files in `source/assets/fonts/`.
- GSAP ships under its own MIT license in `source/assets/gsap.min.js`.
- HTML, CSS, JavaScript and motion rules are contributed under the repository's Apache-2.0
  license. The WebM preview and JPEG poster derive from the verified project export; their
  identities are recorded in `source/manifest.json` and, after maintainer preparation,
  `template.json.remoteAssets`.

## Reference playback

[Download the silent preview](source/assets/lfs/preview.webm) — a 360 × 450 WebM rendition of the
full 17.02 s composition (lightweight viewing copy). The [offline interactive
preview](source/preview.html) plays the same deterministic timeline with play/replay/scrub
controls.

## Verification scope

`source/preview.html` exposes a deterministic `window.__unfoldingConversation` timeline with
play/replay/scrub controls for frame inspection. The project was rendered and exported through
Studio at 720 × 900, 60 fps, 17.02 s; the export passed its automated technical verification
(container, dimensions, frame rate, full decode, seek-first/middle/last). These technical
checks do not establish human visual acceptance, nor the Studio template-copy flow, which
reviewers should verify separately.
