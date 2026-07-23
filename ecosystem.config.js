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

module.exports = {
  apps: [
    {
      name: 'pipeline',
      interpreter: 'python3',
      script: '-m src.workers.orchestrator',
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
      name: 'dashboard',
      script: 'node_modules/.bin/next',
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
  ],
};
