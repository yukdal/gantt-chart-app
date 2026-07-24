module.exports = {
  apps: [{
    name: 'gantt',
    script: 'server.js',
    cwd: '/home/ubuntu/gantt-app',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001,
      HOST: '127.0.0.1',
      DATA_DIR: '/home/ubuntu/gantt-data'
    },
    error_file: '/home/ubuntu/logs/gantt-error.log',
    out_file: '/home/ubuntu/logs/gantt-out.log',
    merge_logs: true,
    max_restarts: 10,
    restart_delay: 3000
  }]
};
