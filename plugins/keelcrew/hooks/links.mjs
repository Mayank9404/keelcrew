#!/usr/bin/env node
// @ts-check
// SessionStart: points ~/.keelcrew/bin/keelctl and keelcrew-helper at this copy of the plugin when an update moved it (see
// core/install.mjs). Never fails the session.
import { healLinks } from '../core/install.mjs';

try {
  healLinks();
} catch {
  /* best effort: keelctl doctor reports a helper the app can't run */
}
