# AI App Builder — Request to Result

An editable, repository-native OpenMotion template that presents app generation as a **request on the left** and a **result growing on the right**. It is a 58.5-second, 1920 × 1080, 30 fps silent composition with twelve scenes and three string variables.

## Use this template

1. Read [the motion and adaptation guide](source/motion.md).
2. Open [the interactive preview](source/preview.html). It runs offline with no build step and shows the motion loop, scene map, palette and edit rules.
3. Open [the editable project](source/index.html) in OpenMotion Studio. The composition source is [compositions/app-builder.html](source/compositions/app-builder.html).
4. Replace `headline`, `request` and `tagline` in the root project variables, then preview the result. For deeper changes, edit the plain HTML/CSS described in the guide.
5. Add narration or music in Studio as a separate audio clip if your delivery needs sound. No audio asset is bundled with this template.

`template.json` lists `index.html` in `entry.files`, so the catalog exposes this entry as an editable project (`hasHtmlProject: true`).

## Editable inputs

- `headline` — opening headline, up to 40 characters.
- `request` — first request shown in the left bubble, up to 90 characters.
- `tagline` — closing line, up to 60 characters.
- Accent — the `--orange` CSS custom property in the composition style block.
- Timing — `data-start` / `data-duration` on the twelve `.clip` elements, matched with the GSAP timestamps.

Keep the request panel visible while the result changes, and keep the task name identical on both sides of each request/result pair.

## Verification scope

The manifest covers all editable source files; `npm run templates:check`, `node --test tests/template-library.test.ts` and `npm run storage:check` were run before submission. Technical checks confirm source integrity and repository policy. They do not establish human visual acceptance, audio delivery or rights clearance for content you add later.

## Acknowledgements

The motion grammar — request on the left, result on the right, skeleton before content, and incremental updates — is a reference to the Airtable “Create an app” post: <https://www.linkedin.com/posts/airtable_airtableai-nocodeai-activity-7343347865622036481-yJJC>. The original reference film and published guidance package remain at the public URLs recorded in catalog entry `motion-a8969c13-c7db-4e76-aa48-cfcb0674cf99`.

All HTML, CSS, geometry, timing and copy in this template are original work contributed under the repository's Apache-2.0 license. No reference footage, interface captures, brand logos, typography or third-party images are redistributed. GSAP is bundled under its own license; see [assets/DEPENDENCIES.md](source/assets/DEPENDENCIES.md) and [assets/GSAP-LICENSE.txt](source/assets/GSAP-LICENSE.txt).
