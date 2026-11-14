'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { signToken } = require('../auth');
const { HttpError, reqStr, normalizePhone } = require('../util');

// Pre-computed hash so unknown phone numbers cost the same time as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

module.exports = function authRoutes({ db, secret, limiter }) {
  const r = express.Router();
  if (limiter) r.use(limiter);

  r.post('/register', (req, res) => {
    const name = reqStr(req.body, 'name', 'Name', 2, 80);
    const phone = normalizePhone(req.body?.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid phone number (10 to 15 digits).');
    const password = String(req.body?.password || '');
    if (password.length < 6 || password.length > 100) throw new HttpError(400, 'Password must be 6 to 100 characters.');
    const role = req.body?.role;
    if (!['patient', 'clinic'].includes(role)) throw new HttpError(400, 'Choose patient or clinic.');
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
      throw new HttpError(409, 'This phone number is already registered. Try logging in.');
    }
    const info = db
      .prepare('INSERT INTO users (name, phone, password_hash, role) VALUES (?,?,?,?)')
      .run(name, phone, bcrypt.hashSync(password, 10), role);
    const user = { id: Number(info.lastInsertRowid), name, phone, role };
    res.status(201).json({ token: signToken(user, secret), user });
  });

  r.post('/login', (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || '');
    const row = phone ? db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) : null;
    const ok = bcrypt.compareSync(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, 'Wrong phone number or password.');
    const user = { id: row.id, name: row.name, phone: row.phone, role: row.role };
    res.json({ token: signToken(user, secret), user });
  });

  r.get('/me', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please log in first.');
    res.json({ user: req.user });
  });

  return r;
};
