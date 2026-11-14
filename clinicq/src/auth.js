'use strict';

const jwt = require('jsonwebtoken');
const { HttpError } = require('./util');

/** Reads the Bearer token (if any) and attaches the matching user to req.user. */
function authMiddleware(db, secret) {
  const getUser = db.prepare('SELECT id, name, phone, role FROM users WHERE id = ?');
  return (req, _res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(h.slice(7), secret);
        req.user = getUser.get(payload.id) || null;
      } catch {
        req.user = null;
      }
    }
    next();
  };
}

function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in first.'));
    if (role && req.user.role !== role) {
      return next(new HttpError(403, role === 'clinic' ? 'This is for clinic accounts only.' : 'This is for patient accounts only.'));
    }
    next();
  };
}

const signToken = (user, secret) => jwt.sign({ id: user.id, role: user.role }, secret, { expiresIn: '7d' });

module.exports = { authMiddleware, requireRole, signToken };
