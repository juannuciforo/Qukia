const logger = require('../utils/logger');

function notFound(req, res) {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}

function errorHandler(err, req, res, next) {
  // Prisma known errors
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'Duplicate record', field: err.meta?.target });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found' });
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large' });
  }
  if (err.message?.startsWith('Unsupported file type')) {
    return res.status(415).json({ error: err.message });
  }

  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    logger.error('Unhandled error', {
      message: err.message,
      stack:   err.stack,
      path:    req.path,
      method:  req.method,
    });
  }

  res.status(status).json({
    error:   status < 500 ? err.message : 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = { notFound, errorHandler };
