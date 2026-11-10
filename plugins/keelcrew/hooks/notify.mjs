#!/usr/bin/env node
// @ts-check
// Notification: the Keelcrew panel mod's notifications (`$.ui.notify(text, { title: 'Keelcrew' })`, urgent, ship and
// failed QA cards whose Claude app push wasn't sent) as a macOS banner. A session in the Claude app has no terminal, so a mod's notification reaches only these hooks
// (as `notification_type: "plugin_notification"`). Every other notification, the app's own permission and idle ones
// included, is left alone. The text goes to osascript as arguments, never into the script. Never fails the session.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { appendRotating, readInput } from '../core/fsx.mjs';
import { paths } from '../core/paths.mjs';

const TITLE = 'Keelcrew';
const MAX_CHARS = 200;
const BUDGET_MS = 4000;
const SCRIPT = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run';

const input = readInput();
const text = typeof input.message === 'string' ? input.message.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS) : '';
if (process.platform === 'darwin' && input.notification_type === 'plugin_notification' && input.title === TITLE && text) {
  execFile('osascript', ['-e', SCRIPT, TITLE, text], { timeout: BUDGET_MS }, (err) => {
    try {
      appendRotating(join(paths.logs(), 'notify.log'), `${new Date().toISOString()} ${err ? `FAILED ${String(err.message).split('\n')[0]}` : 'banner'} | ${text}`);
    } catch {
      /* logging is best effort */
    }
    process.exit(0);
  });
}
