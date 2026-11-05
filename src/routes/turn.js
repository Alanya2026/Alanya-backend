const express = require('express');
const router  = express.Router();
const { authCustom } = require('../middleware/authCustom');
const { buildIceServersWithFallback } = require('../utils/turnCredentials');

/**
 * @swagger
 * /api/turn/credentials:
 *   get:
 *     summary: Récupère les credentials TURN/ICE pour WebRTC
 *     tags: [TURN]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Serveurs ICE et durée de validité
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 iceServers:
 *                   type: array
 *                   items:
 *                     type: object
 *                 ttlSec:
 *                   type: integer
 */
router.get('/credentials', authCustom, async (req, res) => {
  try {
    const { iceServers, ttlSec } = await buildIceServersWithFallback(req.user.alanyaID);
    res.json({ iceServers, ttlSec });
  } catch (error) {
    console.error('[TURN] credentials error:', error.message);
    res.status(500).json({ error: 'Failed to build iceServers', code: 'INTERNAL' });
  }
});

module.exports = router;
