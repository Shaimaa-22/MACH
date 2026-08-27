/*
  mach.waad — Glucose Estimation Firmware (ESP32 + MAX30102 + DS18B20)
  ----------------------------------------------------------------------
  ⚠️ IMPORTANT — READ BEFORE USING FOR ANYTHING BEYOND A DEMO/COMPETITION:

  The formula in estimateGlucose() below is NOT clinically calibrated.
  There is no established physics-based equation that maps PPG signal
  (MAX30102) + skin/body temperature to an exact glucose value. This
  code implements a PLAUSIBLE, research-pattern-based heuristic
  (perfusion-index-style AC/DC ratio + linear temperature compensation)
  so the pipeline produces a real-time number for demo purposes.

  To make this a genuinely accurate device, you'd need to:
    1. Collect N samples of (acRatio, temperature) paired with a real
       glucometer reading at the same moment.
    2. Fit a proper regression (even simple linear regression on those
       pairs) to replace GLUCOSE_A / GLUCOSE_B / GLUCOSE_C below.
    3. Ideally calibrate per-user, since skin tone, perfusion, and
       vessel depth vary a lot and affect the PPG signal.

  Every reading sent to the backend is still tagged `"estimated": true`
  in the JSON payload so the frontend/backend can (and should) surface
  a disclaimer to the doctor/patient.
  ----------------------------------------------------------------------

  Libraries required (Arduino Library Manager):
    - "SparkFun MAX3010x Pulse and Proximity Sensor Library"
    - "OneWire"
    - "DallasTemperature"
    - "LiquidCrystal I2C" (e.g. the frentaly/marcoschwartz fork — search
      "LiquidCrystal I2C" in Library Manager)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include "MAX30105.h"
#include <OneWire.h>
#include <DallasTemperature.h>
#include <LiquidCrystal_I2C.h>

// ---------------- USER CONFIG ----------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Same backend used for device control / readings
const char* API_BASE_URL  = "https://YOUR_BACKEND_URL";  // no trailing slash
const int   PATIENT_ID    = 1;  // set after registering the patient via the app

const int   ONE_WIRE_BUS_PIN = 4; // DS18B20 data pin (needs a 4.7k pull-up to 3.3V)

// I2C LCD — shares the SAME I2C bus as the MAX30102 (SDA/SCL on ESP32 default
// to GPIO 21/22). Most 16x2 I2C backpacks use address 0x27 or 0x3F — if the
// screen stays blank, run an I2C scanner sketch to confirm the address.
const uint8_t LCD_I2C_ADDR = 0x27;
const uint8_t LCD_COLS = 16;
const uint8_t LCD_ROWS = 2;

// Status indicators — no button; status is fully automatic based on the
// reading, since device control (ON/OFF) is handled from the website instead.
const int GREEN_LED_PIN = 25;
const int RED_LED_PIN   = 26;
const int BUZZER_PIN    = 27;

// Same normal range as the backend (server.js NORMAL_RANGE) — keep these two
// in sync if you ever change the backend's default.
const float NORMAL_MIN = 70.0;
const float NORMAL_MAX = 140.0;

// Sampling window per estimate
const int   SAMPLE_COUNT     = 200;   // ~2s at 100Hz
const int   SAMPLE_DELAY_MS  = 10;
const unsigned long READING_INTERVAL_MS = 15000; // send an estimate every 15s

// ---------------- PLACEHOLDER CALIBRATION COEFFICIENTS ----------------
// glucose_estimate = GLUCOSE_A * acRatio + GLUCOSE_B * (tempC - 36.5) + GLUCOSE_C
// These are NOT derived from real calibration data — replace once you have some.
const float GLUCOSE_A = 60.0;   // sensitivity to AC/DC (perfusion) ratio
const float GLUCOSE_B = 3.0;    // mg/dL shift per °C deviation from 36.5°C baseline
const float GLUCOSE_C = 95.0;   // baseline offset (roughly mid-normal-range)

// ---------------- GLOBALS ----------------
MAX30105 particleSensor;
OneWire oneWire(ONE_WIRE_BUS_PIN);
DallasTemperature tempSensor(&oneWire);
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, LCD_COLS, LCD_ROWS);

unsigned long lastReadingSentAt = 0;

// ---------------- LCD HELPERS ----------------
void lcdShowMessage(const String& line1, const String& line2 = "") {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1);
  if (line2.length() > 0) {
    lcd.setCursor(0, 1);
    lcd.print(line2);
  }
}

void lcdShowReading(float glucoseValue, float tempC) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Glucose~");
  lcd.print(glucoseValue, 0);
  lcd.print("mg/dL");

  lcd.setCursor(0, 1);
  lcd.print("Temp:");
  lcd.print(tempC, 1);
  lcd.write((uint8_t)223); // degree symbol
  lcd.print("C EST");
}

// ---------------- STATUS INDICATORS (green/red LED + buzzer) ----------------
// Fully automatic — no button. Mirrors the backend's NORMAL/HIGH/LOW logic
// (server.js) so the device and the website always agree on status.
void updateStatusIndicators(float glucoseValue) {
  bool isAbnormal = (glucoseValue > NORMAL_MAX) || (glucoseValue < NORMAL_MIN);

  digitalWrite(GREEN_LED_PIN, isAbnormal ? LOW : HIGH);
  digitalWrite(RED_LED_PIN,   isAbnormal ? HIGH : LOW);
  digitalWrite(BUZZER_PIN,    isAbnormal ? HIGH : LOW);
}

void clearStatusIndicators() {
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
}

// ---------------- WIFI ----------------
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
}

// ---------------- SENSOR SETUP ----------------
void setupMAX30102() {
  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 not found. Check wiring.");
    while (true) delay(1000);
  }

  byte ledBrightness = 60;  // 0-255
  byte sampleAverage  = 4;
  byte ledMode        = 2;  // Red + IR
  int  sampleRate     = 100;
  int  pulseWidth     = 411;
  int  adcRange       = 4096;

  particleSensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);
}

// ---------------- SIGNAL PROCESSING ----------------
// Collects SAMPLE_COUNT samples and returns the AC/DC ratio (perfusion-style
// index) for both IR and Red channels, combined into a single "R-like" ratio
// the same way pulse oximeters derive their SpO2 ratio.
float collectAcDcRatio() {
  double irSum = 0, redSum = 0;
  double irMin = 1e9, irMax = -1e9;
  double redMin = 1e9, redMax = -1e9;

  int validSamples = 0;

  for (int i = 0; i < SAMPLE_COUNT; i++) {
    long irValue  = particleSensor.getIR();
    long redValue = particleSensor.getRed();

    // Skip samples with no finger/contact detected
    if (irValue < 5000) {
      delay(SAMPLE_DELAY_MS);
      continue;
    }

    irSum  += irValue;
    redSum += redValue;
    irMin  = min(irMin, (double)irValue);
    irMax  = max(irMax, (double)irValue);
    redMin = min(redMin, (double)redValue);
    redMax = max(redMax, (double)redValue);

    validSamples++;
    delay(SAMPLE_DELAY_MS);
  }

  if (validSamples < SAMPLE_COUNT / 2) {
    Serial.println("Not enough valid samples (finger not detected?)");
    return -1;
  }

  double irDC  = irSum / validSamples;
  double redDC = redSum / validSamples;
  double irAC  = irMax - irMin;
  double redAC = redMax - redMin;

  if (irDC <= 0 || redDC <= 0 || irAC <= 0) return -1;

  double acDcIr  = irAC / irDC;
  double acDcRed = redAC / redDC;

  // Same style of ratio pulse oximeters use for SpO2 (R value)
  float ratio = acDcRed / acDcIr;
  return ratio;
}

float readTemperatureC() {
  tempSensor.requestTemperatures();
  float t = tempSensor.getTempCByIndex(0);
  if (t == DEVICE_DISCONNECTED_C) {
    Serial.println("DS18B20 not responding, using fallback 36.5C");
    return 36.5;
  }
  return t;
}

// ---------------- ESTIMATION (see disclaimer at top of file) ----------------
float estimateGlucose(float acRatio, float tempC) {
  float estimate = GLUCOSE_A * acRatio + GLUCOSE_B * (tempC - 36.5) + GLUCOSE_C;

  // Clamp to a plausible display range so a noisy reading doesn't show
  // something absurd like -40 or 900 mg/dL.
  if (estimate < 40) estimate = 40;
  if (estimate > 400) estimate = 400;

  return estimate;
}

// ---------------- SEND TO BACKEND ----------------
void sendReading(float glucoseValue) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected, skipping send.");
    return;
  }

  HTTPClient http;
  String url = String(API_BASE_URL) + "/api/readings";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  String payload = String("{\"patientId\":") + PATIENT_ID +
                    ",\"value\":" + String(glucoseValue, 1) +
                    ",\"estimated\":true}";

  int httpCode = http.POST(payload);
  Serial.printf("POST /api/readings -> %d\n", httpCode);
  if (httpCode > 0) {
    Serial.println(http.getString());
  }
  http.end();
}

// ---------------- MAIN ----------------
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  clearStatusIndicators();

  Wire.begin(); // shared I2C bus for MAX30102 + LCD

  lcd.init();
  lcd.backlight();
  lcdShowMessage("mach.waad", "Starting...");

  connectWiFi();
  lcdShowMessage("WiFi connected", WiFi.localIP().toString());
  delay(1000);

  setupMAX30102();
  tempSensor.begin();

  lcdShowMessage("Place finger", "on sensor...");
  Serial.println("Setup complete. Place finger on MAX30102 sensor.");
}

void loop() {
  if (millis() - lastReadingSentAt >= READING_INTERVAL_MS) {
    lcdShowMessage("Reading...", "Hold still");

    float acRatio = collectAcDcRatio();
    float tempC   = readTemperatureC();

    if (acRatio > 0) {
      float glucoseEstimate = estimateGlucose(acRatio, tempC);
      Serial.printf("acRatio=%.4f tempC=%.2f -> glucose~%.1f mg/dL (UNCALIBRATED)\n",
                    acRatio, tempC, glucoseEstimate);

      lcdShowReading(glucoseEstimate, tempC);
      updateStatusIndicators(glucoseEstimate);
      sendReading(glucoseEstimate);
    } else {
      Serial.println("Skipping send — no valid finger signal this cycle.");
      lcdShowMessage("Place finger", "on sensor...");
      clearStatusIndicators();
    }

    lastReadingSentAt = millis();
  }
}
