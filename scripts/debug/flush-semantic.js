const { Router } = require('express');
const { redis } = require('../../../lib/redis');

const router = Router();

router.post('/flush-semantic', async (req, res) => {
  try {
    const keys = await redis.keys('semantic:*');
    if (keys.length > 0) await redis.del(keys);
    const schemas = await redis.keys('pbi:*');
    res.json({ deleted: keys.length, schemasPreserved: schemas.length, keys });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;