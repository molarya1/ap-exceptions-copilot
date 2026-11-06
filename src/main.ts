import { App, defaultOptions } from './app';
import { env } from './config';
import { createApp } from './server/http';

// `npm start`: build facts, detect issues, replay recorded runs, serve the UI on localhost.

const e = env();
const app = await App.boot(defaultOptions(e));
createApp(app, e.port).listen(e.port, '127.0.0.1', () => {
  const recorded = app.issues.length - app.unrecorded().length;
  console.log(`AP Exceptions Copilot · ${app.issues.length} issues · ${recorded} replayed from recordings · ${app.mode} mode`);
  if (app.extractionMissing.length) console.log(`  ${app.extractionMissing.length} emails have no cached extraction (set LIVE_VIA_CLAUDE_CODE=1 to extract them through Claude Code)`);
  console.log(`  open http://localhost:${e.port}`);
});

if (app.mode === 'live' && app.unrecorded().length > 0) {
  console.log(`  investigating ${app.unrecorded().length} issues live in the background`);
  void app.investigateLive(app.unrecorded());
}
