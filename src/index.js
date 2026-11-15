import { Checker } from './checker.js';
import { configuredNotifiers, notifyAll } from './notify.js';
import { PushStore } from './push.js';
import { startServer } from './server.js';

const args = new Set(process.argv.slice(2));
const env = process.env;
const log = (...m) => console.log(new Date().toISOString(), ...m);

async function main() {
  const push = await new PushStore({
    env,
    keysFile: env.VAPID_FILE || '.vapid.json',
    subscriptionsFile: env.SUBSCRIPTIONS_FILE || 'subscriptions.json',
    log,
  }).init();

  if (args.has('--test-notify')) {
    const notifiers = configuredNotifiers(env, { push });
    if (notifiers.length === 0) {
      throw new Error('No notifier configured; turn on notifications in the UI or set RESEND_API_KEY+EMAIL_TO, NTFY_TOPIC or DISCORD_WEBHOOK_URL');
    }
    const ok = await notifyAll(notifiers, { subject: 'apple-stock test notification', text: 'Notifications are working.' }, log);
    process.exit(ok ? 0 : 1);
  }

  const once = args.has('--once');
  const checker = new Checker({
    env,
    settingsFile: env.SETTINGS_FILE || 'settings.json',
    stateFile: env.STATE_FILE || '.state.json',
    headless: env.HEADLESS !== 'false',
    dryRun: args.has('--dry-run'),
    log,
    push,
  });
  await checker.init();
  if (checker.notifiers().length === 0) log('no notifier yet: turn on notifications in the UI or configure one in .env');

  if (once) {
    await checker.check();
    await checker.close();
    if (checker.error) process.exit(1);
    return;
  }

  const intervalMs = Math.max(30, Number(env.INTERVAL_SECONDS || 30)) * 1000;
  // During FAST_WINDOW (minutes past each hour, e.g. "0-15") check every FAST_INTERVAL_SECONDS
  // instead, and always start right at the top of it. A slower rest of the hour keeps Apple's
  // limit (about 100 checks per ~90 minutes) from running out inside the window.
  const [fastFrom, fastTo] = (env.FAST_WINDOW || '').split('-').map((m) => parseInt(m, 10));
  const hasWindow = Number.isInteger(fastFrom) && Number.isInteger(fastTo);
  const fastMs = Math.max(30, Number(env.FAST_INTERVAL_SECONDS || 30)) * 1000;
  const inWindow = (d) => hasWindow && d.getMinutes() >= fastFrom && d.getMinutes() < fastTo;
  const untilWindow = (d) => {
    if (!hasWindow) return Infinity;
    const start = new Date(d);
    start.setMinutes(fastFrom, 0, 0);
    if (start <= d) start.setHours(start.getHours() + 1);
    return start - d;
  };
  // Apple's shield answers 541 when it decides we're checking too often. Back off for
  // BLOCKED_WAIT_SECONDS after a blocked check, and say so once when it starts and ends.
  const blockedWaitMs = Number(env.BLOCKED_WAIT_SECONDS || 300) * 1000;
  let blockedSince = null;
  const tell = (subject, text) => notifyAll(checker.notifiers(), { subject, text }, log).catch(() => {});
  let timer;
  const schedule = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await checker.check();
      const blocked = Boolean(checker.error?.includes('541'));
      if (blocked && !blockedSince) {
        blockedSince = new Date();
        tell('Apple is blocking stock checks', `Retrying every ${blockedWaitMs / 60_000} minutes until it lets us through.`);
      } else if (!blocked && blockedSince) {
        const minutes = Math.round((Date.now() - blockedSince) / 60_000);
        blockedSince = null;
        tell('Stock checks are working again', `Apple blocked checks for about ${minutes} minutes.`);
      }
      if (blocked) log(`blocked by Apple; next check in ${blockedWaitMs / 1000}s`);
      const now = new Date();
      const wait = blocked ? blockedWaitMs : (inWindow(now) ? fastMs : intervalMs) * (0.85 + Math.random() * 0.3);
      schedule(Math.min(wait, untilWindow(now)));
    }, delay);
  };

  if (!args.has('--no-ui')) {
    startServer(checker, {
      host: env.HOST || '127.0.0.1',
      port: Number(env.PORT || 4321),
      log,
      onSettingsChanged: () => schedule(0),
    });
  }
  schedule(0);

  const shutdown = async () => {
    clearTimeout(timer);
    await checker.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
