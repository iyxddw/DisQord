// PM2 进程配置：三个服务共用一份，从 DisQord 项目根目录启动。
// 依赖：根目录存在 central.env / qq.env / discord.env（各自机器的文件名如有差异自行改 interpreter_args）。
// 说明：不写死 cwd，PM2 以执行 pm2 start 时的目录为工作目录（相对路径的基准），
//       因此必须从项目根目录启动 —— 三个 start-*.sh 脚本已自动 cd 到位。
module.exports = {
  apps: [
    {
      name: 'disqord-central',
      script: 'apps/central-server/dist/index.js',
      interpreter: 'node',
      interpreter_args: ['--env-file=central.env'],
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
      script: 'apps/qq-node/dist/index.js',
      interpreter: 'node',
      interpreter_args: ['--env-file=qq.env'],
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
      script: 'apps/discord-node/dist/index.js',
      interpreter: 'node',
      interpreter_args: ['--env-file=discord.env'],
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
