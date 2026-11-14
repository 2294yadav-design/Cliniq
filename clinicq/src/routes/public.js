'use strict';

const express = require('express');
const { HttpError, idParam, isValidDate } = require('../util');

module.exports = function publicRoutes({ svc }) {
  const r = express.Router();

  r.get('/clinics', (req, res) => {
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : NaN;
    const lng = req.query.lng !== undefined ? Number(req.query.lng) : NaN;
    const clinics = svc.searchClinics({
      q: String(req.query.q || '').slice(0, 100),
      city: String(req.query.city || '').slice(0, 100),
      lat,
      lng,
    });
    res.json({ clinics });
  });

  r.get('/doctors/:id', (req, res) => {
    res.json({ doctor: svc.doctorPublic(idParam(req)) });
  });

  r.get('/doctors/:id/slots', (req, res) => {
    const dc = svc.doctorWithClinic(idParam(req));
    if (!dc) throw new HttpError(404, 'Doctor not found');
    const date = String(req.query.date || '');
    if (!isValidDate(date)) throw new HttpError(400, 'date must look like YYYY-MM-DD');
    svc.validateBookableDate(date);
    const { on_leave, reason, slots } = svc.slotsFor(dc.doctor, date);
    res.json({
      date,
      on_leave,
      reason,
      slots: slots.map(({ start, end, available }) => ({ start, end, available })),
    });
  });

  // Anonymous snapshot of today's queue (tokens only).
  r.get('/doctors/:id/queue', (req, res) => {
    const dc = svc.doctorWithClinic(idParam(req));
    if (!dc) throw new HttpError(404, 'Doctor not found');
    res.json({ queue: svc.publicSummary(dc.doctor, dc.clinic) });
  });

  // Server-sent events: pushes a fresh snapshot whenever the queue changes.
  r.get('/doctors/:id/queue/stream', (req, res) => {
    const dc = svc.doctorWithClinic(idParam(req));
    if (!dc) throw new HttpError(404, 'Doctor not found');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 4000\n\n');
    svc.sendSse(res, 'queue', svc.publicSummary(dc.doctor, dc.clinic));
    svc.addStream(dc.doctor.id, res);
    req.on('close', () => svc.removeStream(dc.doctor.id, res));
  });

  return r;
};
