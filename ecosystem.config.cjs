// PM2 进程配置：三个服务共用一份，从 DisQord 项目根目录启动。
// 依赖：根目录存在 central.env / qq.env / discord.env。
// 由 Bash 启动器直接 exec node，避免 PM2 丢失 Node 的 --env-file 参数。
const projectRoot = __dirname;

module.exports = {
  apps: [
    {
      name: 'disqord-central',
      script: 'deploy/pm2-run-central.sh',
      cwd: projectRoot,
      interpreter: '/bin/bash',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 15000,
      out_file: 'logs/pm2-central-out.log',
      error_file: 'logs/pm2-central-error.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'disqord-qq',
      script: 'deploy/pm2-run-qq.sh',
      cwd: projectRoot,
      interpreter: '/bin/bash',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 15000,
      out_file: 'logs/pm2-qq-out.log',
      error_file: 'logs/pm2-qq-error.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'disqord-discord',
      script: 'deploy/pm2-run-discord.sh',
      cwd: projectRoot,
      interpreter: '/bin/bash',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 15000,
      out_file: 'logs/pm2-discord-out.log',
      error_file: 'logs/pm2-discord-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
