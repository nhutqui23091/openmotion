# AI App Builder — Request to Result

A reusable, editable OpenMotion project that presents app generation as a **request on the left** and a **result growing on the right**. It preserves the reference motion grammar: a request is sent, a layout skeleton appears before content, data fills the same positions, a new input updates the existing result, and the film closes by recapping the result forms.

This is an original HTML recreation of the motion language in the reference film listed in [TEMPLATE.md](../TEMPLATE.md). It is not a frame-by-frame copy and uses no reference footage, screenshots, brand marks or third-party interface images.

## Main motion rules

1. Keep request and result side by side in every result scene. The input panel stays visible as the cause while the right side changes.
2. Both sides share the same task name. Do not rename the task between the request and the result.
3. Show structure before content: skeleton blocks and fields appear first, then charts, rows and values occupy the same positions.
4. Use a different result form for each business case (map, dashboard, feedback form, comparison table), but keep the light work surface, sans-serif type and palette constant.
5. When a new input arrives, change only the affected part of the existing app. Do not introduce a long second task at the end.
6. The closing recap reviews forms already established; it does not add a new capability.

## Scene timing

| Time | Scene | Motion |
|---|---|---|
| 0.00–6.00 | Opening request | Request bubble enters, send mark grows, map window and pins appear |
| 6.00–11.00 | Map result | Map lines, pins and field rows fill the right window |
| 11.00–13.00 | Transition | Single orange mark scales in on the dark field |
| 13.00–17.00 | Second request | New request bubble; empty dashboard frame waits |
| 17.00–22.00 | Skeleton | Four layout blocks grow in sequence |
| 22.00–25.00 | Dashboard | Charts and values occupy the skeleton positions |
| 25.00–32.00 | New task | Request and attachment chip enter; a new column opens |
| 32.00–39.00 | Attachment input | Two file chips and four result rows reveal in order |
| 39.00–43.00 | Feedback form | Fields and a new feedback column appear |
| 43.00–48.00 | Competitor view | Comparison bars grow on the dark field |
| 48.00–55.00 | Recap | Four result cards stagger in |
| 55.00–58.50 | Close | Rules, mark and closing line settle |

Total duration: **58.5 s**. Canvas: 1920 × 1080, 30 fps.

## Palette and type

`#61a6bd` field blue · `#172327` interface ink · `#ca4e25` accent orange · `#174e3e` green · `#e9e9cf` paper. Sans-serif system UI (Arial / Helvetica). Request bubbles and tables use regular weight; result headlines are bold.

## Editable variables

The root project exposes three string variables: `headline`, `request` and `tagline`. They are bound with `data-var-text` in `compositions/app-builder.html`. Scene copy, palette values and the timing table are plain HTML/CSS and can be edited directly.

## Adaptation instructions

1. Open `index.html` in OpenMotion Studio or the editor. The composition source is `compositions/app-builder.html`.
2. Replace the three variables with your product's opening claim, first request and closing tagline.
3. For a deeper adaptation, edit the text inside scenes 1, 2, 4, 7 and 8 so the request explains the result shown on the right. Keep the task name identical across each request/result pair.
4. Change the accent by editing `--orange` in the composition `<style>` block. Keep the accent on marks, bars and pins rather than on body copy.
5. To swap a result form, replace the shapes inside the relevant `.window` or `.card` container. Keep the container position so loading and completed states still align.
6. Adjust the `data-start` and `data-duration` values of the twelve `.clip` elements together with the matching GSAP timestamps if you change the pacing. Refresh the manifest and run the checks after any source edit.
7. The project is silent. Add a narration/music track in Studio as an audio clip spanning 0–58.5 s if your delivery requires sound; no audio asset is bundled with this template.

## Verification boundary

The HTML is an authored, editable composition. Technical checks confirm that it loads and renders; they do not establish human visual acceptance or rights clearance for any content you add.
