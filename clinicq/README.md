# ClinicQ

Book a doctor and follow the clinic queue live, without phone calls or waiting-room crowds.

- **Patients** search nearby clinics, see whether the doctor is in, book a time slot, or join today's queue remotely and get alerted when their turn is close.
- **Clinics** register doctors and weekly timings, run the live queue from a dashboard (call next, skip, add walk-ins), and flag "on a break / away / closed today" in one tap.

Web MVP built with Node.js, Express and SQLite. No build step. The API is plain JSON, so a mobile app can reuse it later.

## Run it locally

Requires Node.js 18 or newer.

```bash
npm install
npm run seed     # optional: demo clinics, doctors and accounts
npm start        # http://localhost:3000
npm test         # backend test suite
```

To try it on your phone, open `http://<your-computer-ip>:3000` on the same Wi-Fi.

### Real clinics around Dhanori, Pune

```bash
npm run seed:dhanori      # adds 10 general physicians near Dhanori (safe to run twice)
npm run claim -- --list   # shows clinic ids and which are "listed" vs "live"
```

These are **directory listings**: rating, address, phone, today's hours, and a Call button. The clinics have not
joined ClinicQ, so booking and the live queue are switched off for them (the app never claims a listed doctor is
"in"). When a clinic agrees to use ClinicQ:

1. The clinic signs up in the app as **I run a clinic**.
2. You run `npm run claim -- <clinicId> <their phone number>`. That clinic then goes live with booking and the queue.

Data in `src/seed-dhanori.js` is a snapshot from Google Maps (14 Nov 2026). Blank qualification or fee means no
source stated it. Re-check ratings, hours and fees before showing this to real patients, and read Google's terms
before storing Google data long term; the safer route is to let clinics enter their own details when they join.

### Demo accounts (after `npm run seed`)

| Role | Phone | Password |
| --- | --- | --- |
| Patient | 9000000100 | patient123 |
| Clinic owner (Green Cross) | 9000000001 | clinic123 |
| Clinic owner (CityCare) | 9000000002 | clinic123 |

### Try the full flow in 2 minutes

1. Log in as a **clinic owner** in a normal window, open **Dashboard → Live queue**.
2. Log in as the **patient** in a private window, open a doctor and tap **Join today's queue** (the queue is open during the doctor's session, and up to an hour before it).
3. Back on the dashboard press **Call next patient**. The patient's page updates instantly and alerts when their turn is near.

Seeded timings are real weekly schedules, so a doctor only shows as "in" during their session. Edit timings under **Doctors & timings** to test at any hour.

## How it works

| Concept | Behaviour |
| --- | --- |
| Slots | Generated from each doctor's weekly sessions and consultation length. Booked or past slots are disabled. One live booking per slot (enforced by a database index), one booking per patient per doctor per day. |
| Live queue | Appointments and remote/walk-in joiners share one queue. Order is by slot time for appointments and by join time for the rest. Positions and wait estimates use the doctor's real average consultation time once 3 patients are done, otherwise the slot length. |
| Live updates | Server-Sent Events push every queue change. The pages also poll as a fallback. |
| Today's status | Clinic "closed today", doctor "on break/away" and notices expire at midnight automatically. |
| Time zone | `APP_TZ` (default `Asia/Kolkata`) decides what "today" and slot times mean. |

## Project layout

```
src/
  server.js        entry point (env, DB, listen)
  app.js           Express app, security headers, error handling
  db.js            SQLite schema
  services.js      slots, booking, queue engine, live streams
  routes/          auth, public, patient, clinic endpoints
  seed.js          demo data
public/            static web app (vanilla JS modules, no build)
test/              API tests (node:test, in-memory DB, fake clock)
```

### Main API endpoints

Public: `GET /api/clinics?q=&lat=&lng=`, `GET /api/doctors/:id`, `GET /api/doctors/:id/slots?date=`, `GET /api/doctors/:id/queue`, `GET /api/doctors/:id/queue/stream` (SSE)

Patient: `POST /api/doctors/:id/appointments`, `POST /api/doctors/:id/queue/join`, `GET /api/me/queue`, `GET /api/me/appointments`, `POST /api/appointments/:id/cancel`, `POST /api/queue/:id/leave`

Clinic: `/api/clinic`, `/api/clinic/doctors[/:id]`, `.../schedule`, `.../time-off`, `.../status`, `.../queue`, `.../queue/next`, `.../queue/:entryId/:action`

## Configuration

Copy `.env.example` values into your environment. For anything beyond local testing set `NODE_ENV=production` and a long random `JWT_SECRET` (the server refuses to start without it).

## Known limits of this MVP

- **Alerts need the page open.** "Your turn is near" alerts come from the open browser tab (in-page banner, vibration, browser notification). When the tab is closed or the phone is locked, nothing reaches the patient. Reliable alerts need SMS/WhatsApp or push notifications (see roadmap).
- **No OTP.** Accounts use phone number + password; phone numbers are not verified.
- **One clinic per clinic account**, and one receptionist login per clinic.
- Changing a doctor's timings or consultation length does not move already-booked appointments.
- SQLite on one server is fine for a pilot. For many clinics, move to PostgreSQL and run behind HTTPS.
- Appointment holders who have not arrived stay in the queue at their slot time; reception can **Skip** them and put them **Back in line** when they arrive.

## Roadmap ideas

1. SMS/WhatsApp/push notifications for "your turn is near" (biggest value for the no-queue goal)
2. OTP phone verification
3. Patient "I've arrived" check-in
4. Multiple staff logins per clinic and clinic photos/maps links
5. Mobile app (the existing JSON API can be reused as is)
