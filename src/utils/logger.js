const winston = require('winston');
const { isDev } = require('../config/env');

const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    isDev
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `${timestamp} [${level}] ${message}${extra}`;
          })
        )
      : winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    ...(!isDev
      ? [
          new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
          new winston.transports.File({ filename: 'logs/combined.log' }),
        ]
      : []),
  ],
});

module.exports = logger;
