const dns = require("dns");
dns.setDefaultResultOrder("ipv4first"); // force IPv4-first DNS resolution globally (fixes Render + Gmail IPv6 ENETUNREACH)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const mqtt = require("mqtt");

const app = express();
const dbPath = path.join(__dirname, "glucose.db");
const db = new sqlite3.Database(dbPath);

// ---------------- MQTT (device ON/OFF control) ----------------
const MQTT_TOPIC_COMMAND = "machwaad/device/command"; // backend -> ESP32
const MQTT_TOPIC_STATUS  = "machwaad/device/status";  // ESP32 -> backend (incl. LWT "OFFLINE")

let mqttClient = null;
let lastKnownDeviceStatus = "UNKNOWN";

function setupMqtt() {
  if (!process.env.MQTT_URL) {
    console.warn("WARNING: MQTT_URL not set in .env — device control disabled.");
    return;
  }

  mqttClient = mqtt.connect(process.env.MQTT_URL, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD
  });

  mqttClient.on("connect", () => {
    console.log("MQTT connected");
    mqttClient.subscribe(MQTT_TOPIC_STATUS);
  });

  mqttClient.on("message", (topic, message) => {
    if (topic === MQTT_TOPIC_STATUS) {
      lastKnownDeviceStatus = message.toString();
      run(
        `INSERT INTO device (id, status, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP`,
        [lastKnownDeviceStatus]
      ).catch((err) => console.error("device status persist error:", err));
    }
  });

  mqttClient.on("error", (err) => console.error("MQTT error:", err));
}

const SYSTEM_DOCTOR = {
  name: process.env.DOCTOR_NAME || "د. أحمد",
  email: "shaimaadwedar03@gmail.com",
  whatsapp: process.env.DOCTOR_WHATSAPP
};

if (!SYSTEM_DOCTOR.email || !SYSTEM_DOCTOR.whatsapp) {
  console.warn(
    "WARNING: DOCTOR_EMAILS / DOCTOR_WHATSAPP not set in .env — doctor alerts will fail until configured."
  );
}

const NORMAL_RANGE = {
  min: 70,
  max: 140
};

let activePatientId = null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// Gmail SMTP credentials — hardcoded per request (not using .env for these).
const EMAIL_USER = "shaimaadwedar03@gmail.com";
const EMAIL_PASS = "hmit nhmv xndc opxn"; // Gmail App Password (16-char, spaces are fine)

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  family: 4, // force IPv4 — Render's network can't route to Gmail's IPv6 address
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});

function sendEmail(to, subject, text) {
  return transporter.sendMail({
    from: EMAIL_USER,
    to,
    subject,
    text
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function initDb() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS doctors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_name TEXT NOT NULL,
          email TEXT NOT NULL,
          whatsapp_number TEXT NOT NULL
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS patients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_name TEXT NOT NULL,
          age INTEGER NOT NULL,
          normal_min REAL NOT NULL DEFAULT 70,
          normal_max REAL NOT NULL DEFAULT 140,
          doctor_id INTEGER NOT NULL,
          FOREIGN KEY (doctor_id) REFERENCES doctors(id)
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS readings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL,
          glucose_value REAL NOT NULL,
          status TEXT NOT NULL,
          estimated INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients(id)
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS device (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'UNKNOWN',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

async function getOrCreateDoctor() {
  const existing = await get(`SELECT * FROM doctors LIMIT 1`);

  if (existing) return existing;

  const result = await run(
    `
      INSERT INTO doctors (full_name, email, whatsapp_number)
      VALUES (?, ?, ?)
    `,
    [SYSTEM_DOCTOR.name, SYSTEM_DOCTOR.email, SYSTEM_DOCTOR.whatsapp]
  );

  return {
    id: result.lastID,
    full_name: SYSTEM_DOCTOR.name,
    email: SYSTEM_DOCTOR.email,
    whatsapp_number: SYSTEM_DOCTOR.whatsapp
  };
}

app.post("/api/register-patient", async (req, res) => {
  try {
    const { patientName, age } = req.body;

    if (!patientName || !age) {
      return res.status(400).json({ error: "patientName and age are required" });
    }

    const doctor = await getOrCreateDoctor();

    const result = await run(
      `
        INSERT INTO patients (full_name, age, normal_min, normal_max, doctor_id)
        VALUES (?, ?, ?, ?, ?)
      `,
      [patientName, Number(age), NORMAL_RANGE.min, NORMAL_RANGE.max, doctor.id]
    );

    activePatientId = result.lastID;

    res.json({
      success: true,
      patientId: result.lastID
    });
  } catch (error) {
    console.error("register-patient error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/readings", async (req, res) => {
  try {
    const { patientId, value, estimated } = req.body;
    const targetPatientId = patientId || activePatientId;

    if (!targetPatientId) {
      return res.status(400).json({ error: "No active patient selected" });
    }

    const patient = await get(
      `
        SELECT
          p.id,
          p.full_name,
          p.age,
          p.normal_min,
          p.normal_max,
          d.email AS doctor_email,
          d.whatsapp_number AS doctor_whatsapp
        FROM patients p
        JOIN doctors d ON p.doctor_id = d.id
        WHERE p.id = ?
      `,
      [Number(targetPatientId)]
    );

    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    let status = "NORMAL";
    if (Number(value) > patient.normal_max) status = "HIGH";
    else if (Number(value) < patient.normal_min) status = "LOW";

    const isEstimated = estimated ? 1 : 0;

    const readingResult = await run(
      `
        INSERT INTO readings (patient_id, glucose_value, status, estimated)
        VALUES (?, ?, ?, ?)
      `,
      [patient.id, Number(value), status, isEstimated]
    );

    const reading = await get(
      `
        SELECT
          id,
          patient_id AS patientId,
          glucose_value AS glucoseValue,
          status,
          estimated,
          created_at AS createdAt
        FROM readings
        WHERE id = ?
      `,
      [readingResult.lastID]
    );

    let whatsappLink = null;

    if (status === "HIGH" || status === "LOW") {
      const estimateNote = isEstimated
        ? "\n\n(ملاحظة: هذه قراءة تقديرية من حساس غير معايَر طبياً، وليست بديلاً عن جهاز قياس السكر التقليدي)"
        : "";

      const msg = status === "HIGH"
        ? `تنبيه ارتفاع سكر

اسم المريض: ${patient.full_name}
العمر: ${patient.age}
القراءة الحالية: ${value} mg/dL
الطبيعي: ${patient.normal_min}-${patient.normal_max}${estimateNote}`
        : `تنبيه انخفاض سكر

اسم المريض: ${patient.full_name}
العمر: ${patient.age}
القراءة الحالية: ${value} mg/dL
الطبيعي: ${patient.normal_min}-${patient.normal_max}${estimateNote}`;

      const subject = status === "HIGH"
        ? `تنبيه ارتفاع سكر - ${patient.full_name}`
        : `تنبيه انخفاض سكر - ${patient.full_name}`;

      // Fire-and-forget: don't block the ESP32's response on Gmail SMTP.
      // Sending can take several seconds and was causing the device's
      // HTTP request to time out (-11) specifically on HIGH/LOW readings.
      console.log(`Attempting to send alert email. doctor_email in DB = "${patient.doctor_email}"`);
      sendEmail(patient.doctor_email, subject, msg)
        .then(() => console.log("sendEmail succeeded"))
        .catch((err) => {
          console.error("sendEmail error (non-blocking):", err);
        });

      const doctorPhone = patient.doctor_whatsapp.replace(/\D/g, "");
      whatsappLink = `https://wa.me/${doctorPhone}?text=${encodeURIComponent(msg)}`;
    }

    res.json({
      success: true,
      reading,
      whatsappLink
    });
  } catch (error) {
    console.error("readings error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/patients/:id/latest", async (req, res) => {
  try {
    const reading = await get(
      `
        SELECT
          id,
          patient_id AS patientId,
          glucose_value AS glucoseValue,
          status,
          estimated,
          created_at AS createdAt
        FROM readings
        WHERE patient_id = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 1
      `,
      [Number(req.params.id)]
    );

    res.json(reading || null);
  } catch (error) {
    console.error("latest reading error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/patients/:id/history", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 200);

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `
          SELECT
            id,
            patient_id AS patientId,
            glucose_value AS glucoseValue,
            status,
            estimated,
            created_at AS createdAt
          FROM readings
          WHERE patient_id = ?
          ORDER BY datetime(created_at) DESC
          LIMIT ?
        `,
        [Number(req.params.id), limit],
        (err, result) => (err ? reject(err) : resolve(result))
      );
    });

    res.json(rows.reverse()); // oldest -> newest, ready for charting
  } catch (error) {
    console.error("history error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/device/control", (req, res) => {
  if (!mqttClient) {
    return res.status(503).json({ error: "Device control not configured (MQTT_URL missing)" });
  }

  const { action } = req.body;
  if (action !== "ON" && action !== "OFF") {
    return res.status(400).json({ error: 'action must be "ON" or "OFF"' });
  }

  mqttClient.publish(MQTT_TOPIC_COMMAND, action, { qos: 1 }, (err) => {
    if (err) {
      console.error("MQTT publish error:", err);
      return res.status(500).json({ error: "Failed to send command" });
    }
    res.json({ success: true, action });
  });
});

app.get("/api/device/status", async (req, res) => {
  try {
    const row = await get(`SELECT status, updated_at AS updatedAt FROM device WHERE id = 1`);
    res.json(row || { status: "UNKNOWN", updatedAt: null });
  } catch (error) {
    console.error("device status error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, activePatientId });
});

initDb()
  .then(() => {
    setupMqtt();
    app.listen(process.env.PORT || 10000, () => {
      console.log(`Running on ${process.env.PORT || 10000}`);
    });
  })
  .catch((error) => {
    console.error("Database init failed:", error);
    process.exit(1);
  });
