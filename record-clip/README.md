# record-clip

A Claude Code skill that records an agent's browser check as a short, watchable video. It uses Playwright's built-in `recordVideo`, so the browser writes the file and recording costs no model tokens. A small injected script (`cursor-overlay.js`) draws a visible cursor and a ring on every click, since Playwright videos don't show the OS cursor, and `slowMo` keeps each step readable. Clips are converted to `.mp4` with ffmpeg and saved in a dated folder.

The skill also tells the agent to assert every claim the clip makes, record into a scratch folder and deliver only passing runs, keep clips short, never commit them, and never record secrets or real personal data (with a blur-and-verify recipe for when real data can't be avoided).

## Install

Copy the `record-clip` folder into one of:

- `~/.claude/skills/record-clip/` (available in every project)
- `<your-project>/.claude/skills/record-clip/` (one project only)

The setup snippet in `SKILL.md` loads the overlay from `~/.claude/skills/record-clip/cursor-overlay.js`. If you install it per project, change that path.

## Requirements

- Node.js 18 or newer
- Playwright (`npm i -D playwright` or `@playwright/test`, then `npx playwright install chromium`)
- ffmpeg on your `PATH` for `.mp4` conversion (optional; without it clips stay `.webm`)

## Usage

Ask Claude Code to "record a clip" of a flow, or let it pick the skill up when it checks a change in a browser. A minimal recorded script looks like this:

```js
import { chromium } from 'playwright';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const overlay = path.join(os.homedir(), '.claude/skills/record-clip/cursor-overlay.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
const day = new Date().toISOString().slice(0, 10);
const outDir = path.join(os.homedir(), 'Videos/agent-runs', day);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ slowMo: 250 });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: scratch, size: { width: 1280, height: 800 } },
});
await context.addInitScript({ path: overlay });

const page = await context.newPage();
await page.goto('http://localhost:3000');
await page.mouse.move(640, 400, { steps: 15 });
await page.getByRole('button', { name: 'Sign up' }).click();
assert.match(page.url(), /\/signup$/);
await page.waitForTimeout(1000);

const video = page.video();
await context.close();
await browser.close();

const webm = await video.path();
const mp4 = path.join(outDir, 'myapp-feature-branch-signup-button.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
fs.rmSync(scratch, { recursive: true, force: true });
console.log(mp4);
```

## License

MIT, see `LICENSE`.
