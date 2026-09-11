const fs = require('fs');
const path = require('path');

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return env;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        return env;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      env[key] = value;
      return env;
    }, {});
}

const rootEnv = loadDotenv(path.join(__dirname, '.env'));

// The operator can switch the bounce alarm off with BOUNCE_MONITOR_ENABLED=false
// in .env. The switch has to live here, not in a `pm2 delete` on the box:
// every deploy runs `pm2 delete all` and then `pm2 start ecosystem.config.js`,
// so a process removed by hand comes straight back on the next deploy and
// starts texting again with nobody having decided it should. Anything other
// than the literal string false leaves the alarm on, so a typo fails loud.
const bounceMonitorEnabled = rootEnv.BOUNCE_MONITOR_ENABLED !== 'false';

module.exports = {
  apps: [
    {
      name: 'pipeline',
      interpreter: '/root/printeriq/.venv/bin/python',
      script: 'src/workers/orchestrator.py',
      cwd: '/root/printeriq/services/pipeline',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // Stall alarm. Answers one question every 5 minutes: has any queue job
      // reached a terminal state recently, given there is work waiting?
      //
      // On 2026-08-25 the pipeline process below deadlocked with all 5
      // concurrency slots held by jobs that never returned. PM2 reported it
      // `online` with 0 restarts, CPU 0%, memory normal, and nobody noticed
      // for two weeks. Nothing in-process could have caught that, which is
      // why this is its own process.
      //
      // One-shot, restarted on a cron: autorestart false so a clean exit is
      // not treated as a crash, cron_restart so PM2 relaunches it every 5
      // minutes. A monitor that hangs is replaced by the next cron tick
      // rather than becoming a second silent failure.
      name: 'pipeline-stall-monitor',
      interpreter: '/root/printeriq/.venv/bin/python',
      script: 'src/ops/stall_monitor.py',
      args: '--once',
      cwd: '/root/printeriq/services/pipeline',
      watch: false,
      autorestart: false,
      cron_restart: '*/5 * * * *',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      // Bounce rate alarm. Answers one question every 15 minutes: is the cold
      // email bounce rate above the level where sending domains start getting
      // burned, on enough volume for the rate to mean anything?
      //
      // Reads the counts from Instantly rather than our own database. Our
      // tables only learn about a bounce through the Instantly webhook, and
      // that webhook silently dropped every event for months until #165, so
      // it is the wrong source of truth for a deliverability alarm.
      //
      // 15 minutes rather than the stall monitor's 5: a bounce rate is a
      // daily aggregate that cannot move meaningfully inside a quarter of an
      // hour, and every check is a live Instantly API call.
      //
      // One-shot on a cron, same as the stall monitor. autorestart false so a
      // clean exit is not read as a crash, cron_restart so PM2 relaunches it.
      name: 'pipeline-bounce-monitor',
      interpreter: '/root/printeriq/.venv/bin/python',
      script: 'src/ops/bounce_monitor.py',
      args: '--once',
      cwd: '/root/printeriq/services/pipeline',
      watch: false,
      autorestart: false,
      cron_restart: '*/15 * * * *',
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      name: 'reply-agent',
      script: 'dist/webhook.js',
      cwd: '/root/printeriq/services/reply-agent',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
    {
      // Drains the `replies` BullMQ queue that reply-agent produces onto.
      // No PORT: this process listens on Redis, not HTTP.
      name: 'reply-worker',
      script: 'dist/worker.js',
      cwd: '/root/printeriq/services/reply-agent',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
      },
    },
    {
      name: 'dashboard',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      cwd: '/root/printeriq/services/dashboard',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        ...rootEnv,
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ].filter((app) => bounceMonitorEnabled || app.name !== 'pipeline-bounce-monitor'),
};
