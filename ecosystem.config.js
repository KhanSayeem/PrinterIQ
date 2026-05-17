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
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
