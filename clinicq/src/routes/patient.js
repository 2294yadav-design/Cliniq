'use strict';

const express = require('express');
const { requireRole } = require('../auth');
const { idParam, reqInt, optStr } = require('../util');

module.exports = function patientRoutes({ svc }) {
  const r = express.Router();
  const patient = requireRole('patient');

  r.post('/doctors/:id/appointments', patient, (req, res) => {
    const date = String(req.body?.date || '');
    const start = String(req.body?.start || '');
    const reason = optStr(req.body, 'reason', 'Reason', 200);
    const appointment = svc.bookAppointment(req.user, idParam(req), date, start, reason);
    res.status(201).json({ appointment });
  });

  r.post('/doctors/:id/queue/join', patient, (req, res) => {
    const notify = req.body?.notify_position == null ? 3 : reqInt(req.body, 'notify_position', 'Alert position', 1, 10);
    const entry = svc.joinQueue(req.user, idParam(req), notify);
    res.status(201).json({ entry });
  });

  r.get('/me/queue', patient, (req, res) => {
    res.json({ entries: svc.myQueue(req.user.id) });
  });

  r.get('/me/appointments', patient, (req, res) => {
    res.json({ appointments: svc.myAppointments(req.user.id), today: svc.now().date });
  });

  r.post('/appointments/:id/cancel', patient, (req, res) => {
    res.json({ appointment: svc.cancelAppointment(idParam(req), { patientId: req.user.id }) });
  });

  r.post('/queue/:id/leave', patient, (req, res) => {
    svc.leaveQueue(idParam(req), req.user.id);
    res.json({ ok: true });
  });

  r.patch('/queue/:id', patient, (req, res) => {
    const position = reqInt(req.body, 'notify_position', 'Alert position', 1, 10);
    svc.setNotify(idParam(req), req.user.id, position);
    res.json({ ok: true });
  });

  return r;
};
