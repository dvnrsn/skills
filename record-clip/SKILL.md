---
name: record-clip
description: Record a browser check as a short Playwright video with a visible cursor and click rings, then save it as an .mp4 in a dated clips folder. Use whenever an agent checks a change in a real browser (preview checks, smoke tests, demos, end-to-end verification), or when asked to "record a clip", "record the check", or "make a video" of a flow.
---

# Record a browser check

Clips let a person review an agent's browser check later by watching it. Playwright's `recordVideo` writes the file itself, so recording costs no tokens. Never build clips from screenshots or GIF tools, and never watch the video back.

## Video or image

A clip is for flows: clicks, navigation, things that change over time. When the check compares static states side by side (the same screen across roles, viewports or themes), make one composite image instead: a Playwright screenshot per state, stitched into a labeled grid (for example with ImageMagick `montage`), saved next to the clips as `.png`. Use a clip only for the parts that move.

## Setup

Apply all of this only on recorded runs, gated on the same flag that turns `recordVideo` on. Normal test and CI runs never get the overlay or the slowdown.

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OVERLAY = path.join(os.homedir(), '.claude/skills/record-clip/cursor-overlay.js');

const browser = await chromium.launch({ slowMo: 250 });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: scratchDir, size: { width: 1280, height: 800 } },
});
if (fs.existsSync(OVERLAY)) await context.addInitScript({ path: OVERLAY });
else console.warn(`record-clip: ${OVERLAY} not found, recording without the cursor`);
```

- `cursor-overlay.js` (next to this file) draws a cursor that follows `mousemove` and a red ring on every `mousedown`. It survives navigations, re-attaches itself when hydration or the app replaces the page's children, and sits above dialogs. If the skill is installed in a project's `.claude/skills/` instead, point `OVERLAY` there.
- Put the clip's claims in the same script as assertions: `expect` from `@playwright/test` if the repo has it, otherwise `node:assert`. Assert what the clip shows, such as a subtotal's text, a row's order or a redirect URL. The clip proves only what is asserted, so assert each claim the report makes. If an assertion fails, don't deliver the clip; say so in the report.
- Record into a scratch folder (`scratchDir`), never straight into the clips folder. Deliver only after every assertion passed and `context.close()` ran; on failure, delete the scratch videos.
- `slowMo: 250` keeps each step readable at normal speed.
- `locator.click()` moves the mouse, so the cursor follows. Before a click that would otherwise jump across the screen, glide there: `await page.mouse.move(x, y, { steps: 15 })`.
- Load pages with `page.goto` (a `data:` URL works for fixtures). `page.setContent` wipes the overlay and its listeners without re-running init scripts.
- Pause about 1s on the end state before closing, so the result is visible.
- Close the context (`await context.close()`) to flush the video, then convert each `.webm` in the scratch folder (a popup records its own) to the clip name as `.mp4` and delete the `.webm`: `ffmpeg -loglevel error -y -i <recorded>.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an <clip>.mp4 && rm <recorded>.webm`. The `.mp4` plays in most previewers and is about half the size. If `ffmpeg` is missing, keep the `.webm` under the clip name and say so in the report.

Load `cursor-overlay.js` from the installed skill folder, as above, in repo test setups and throwaway `npx playwright` scripts alike. Don't copy it into repos, so one edit reaches every project. If the file is missing, print a warning and record without the cursor rather than failing.

If a repo has no Playwright setup, use a throwaway script in a scratch folder with `npx playwright` rather than adding a dependency to the repo.

## Where clips go

- Default path: `~/Videos/agent-runs/YYYY-MM-DD/<project>-<PR or branch>-<what>.mp4` (create the folder). Use a different clips folder if the user has set one. One short clip per behavior checked.
- Never put a local path (`~/Videos/...`) in a PR description or PR comment: reviewers can't open it. Attach or upload the clip wherever the team can see it, and mention that in the PR's verification notes. Images (grids, stills) can go in the PR itself.

## Hook it into your workflow (optional)

If you keep a running notes file per project, add one line per clip right after saving it (path, PR or branch, what it shows) under a dated heading, so the day's clips are easy to find. If an issue tracker holds the task, attach the clip there. If something cleans up old clips, prune notes entries that point at deleted files.

## Never

- Record screens showing real users' personal data or secrets. Use local, seeded or mock data.
- Record a page with real data unblurred. When a check has to run where real data shows (a PR preview or staging copied from production), blur every element showing people's names, customer names, account or order numbers, emails and addresses with recording-only CSS (`filter: blur(6px)`), added through `context.addInitScript` before the first navigation, so the page never renders it unblurred after load. Keep labels, column headers, totals and layout readable, since those are what the clip proves. Before the claim checks, wait for a known data row, then assert that the sensitive selectors match at least one visible element and that every visible match has a computed `filter` containing `blur(` (assert on the matched elements themselves, since `filter` isn't inherited). A failed guard means no clip. The selector list is the only guard, so add a selector whenever a new sensitive field appears. If the change itself is in a field that would need blurring, record against seeded data or skip the clip and say so.

  ```ts
  const filters = await page.$$eval(SENSITIVE, (els) =>
    els.filter((el) => el.getClientRects().length > 0).map((el) => getComputedStyle(el).filter),
  );
  assert(filters.length > 0 && filters.every((f) => /blur\(/.test(f)));
  ```
- Commit clips to any repo.
