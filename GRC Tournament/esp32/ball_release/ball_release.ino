/* =====================================================================
   GRC Tournament · Ball release (ESP32 + servo)
   ---------------------------------------------------------------------
   Staff press "Release balls" on the staff page (control.html).
   This ESP32 asks Supabase about twice a second whether there is a new
   release. When there is, it opens the servo gate, waits, closes it
   again and reports back, so the staff page shows "Released ✓".

   Step-by-step setup: esp32/README.md and ESP32-Ball-Release-Setup-Guide.pdf
   Board:   WEMOS LOLIN32 V1.0.0 (choose "ESP32 Dev Module" or "WEMOS LOLIN32")
            Other ESP32 boards work too: see LED_PIN and LED_ACTIVE_LOW below.
   Needs:   the "esp32 by Espressif Systems" board package. No extra libraries.

   Safety
   - After power-up it never replays a release that happened earlier.
   - It ignores a release that is more than 20 seconds old (for example
     when the Wi-Fi dropped and came back), so balls never drop late.
   - To test the gate without the website, briefly connect pin 0 to GND
     with a jumper wire (on boards that have a BOOT button, press BOOT).
   ===================================================================== */

#include <WiFi.h>
#include <WiFiMulti.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "secrets.h is missing. In this folder, copy secrets.example.h, rename the copy to secrets.h and fill in your Wi-Fi name, password and device token."
#endif

// ---------------------------------------------------------------------
// Settings you can change
// ---------------------------------------------------------------------
const int SERVO_PIN = 18;                 // servo signal wire (orange / yellow / white)
const int CLOSED_ANGLE = 0;               // gate shut, holding the balls (0 to 180)
const int OPEN_ANGLE = 90;                // gate open, balls drop (0 to 180)
const unsigned long HOLD_OPEN_MS = 1500;  // how long the gate stays open (milliseconds)
const int SERVO_MIN_US = 500;             // pulse width at 0 degrees   (most servos: 500)
const int SERVO_MAX_US = 2500;            // pulse width at 180 degrees (most servos: 2400 to 2500)

// Blue LED: ON = connected to Supabase.
// LOLIN32: pin 5, lights when the pin is LOW. ESP32 DevKit: pin 2 and false.
// If the LED does the opposite of what it should, flip LED_ACTIVE_LOW.
const int LED_PIN = 5;
const bool LED_ACTIVE_LOW = true;

// Test input: connecting pin 0 to GND for a moment opens the gate.
// (Pin 0 is also the BOOT button on boards that have one.)
const int TEST_BUTTON_PIN = 0;

const unsigned long POLL_MS = 500;  // how often to ask Supabase for news
const long MAX_AGE_S = 20;          // ignore a release older than this many seconds

// Supabase project: public values, the same as assets/config.js
const char* SUPABASE_URL = "https://qponplxxgemmiijcboza.supabase.co";
const char* SUPABASE_KEY = "sb_publishable_zkTme6JRjK6DrRyzd_r6hQ_gZf-AyvK";

// ---------------------------------------------------------------------

const int SERVO_FREQ_HZ = 50;   // standard servo signal: one pulse every 20 ms
const int SERVO_BITS = 14;      // PWM resolution (works on every ESP32 type)
const int SERVO_CHANNEL = 0;    // only used by older board packages (2.x)

WiFiMulti wifiMulti;
WiFiClientSecure tls;
HTTPClient http;

long lastSeenId = -1;  // newest release we know about (-1 = not synced since power-up)
long lastDoneId = 0;   // newest release we carried out
unsigned long lastPoll = 0;
bool pollNow = true;
bool online = false;
int failures = 0;

// ---------------------------------------------------------------- servo
void servoBegin() {
  // The PWM output starts at 0 (no pulses), so the servo does not move
  // until servoAngle() below sends the CLOSED position.
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(SERVO_PIN, SERVO_FREQ_HZ, SERVO_BITS);
#else
  ledcSetup(SERVO_CHANNEL, SERVO_FREQ_HZ, SERVO_BITS);
  ledcAttachPin(SERVO_PIN, SERVO_CHANNEL);
#endif
}

void servoAngle(int angle) {
  angle = constrain(angle, 0, 180);
  long us = map(angle, 0, 180, SERVO_MIN_US, SERVO_MAX_US);
  uint32_t duty = (uint32_t)(us * ((1L << SERVO_BITS) - 1) / (1000000L / SERVO_FREQ_HZ));
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(SERVO_PIN, duty);
#else
  ledcWrite(SERVO_CHANNEL, duty);
#endif
}

void setLed(bool on) { digitalWrite(LED_PIN, (on != LED_ACTIVE_LOW) ? HIGH : LOW); }

void releaseBalls(const char* why) {
  Serial.printf("Opening the gate (%s)\n", why);
  setLed(false);
  servoAngle(OPEN_ANGLE);
  delay(HOLD_OPEN_MS);
  servoAngle(CLOSED_ANGLE);
  setLed(online);
  Serial.println("Gate closed");
}

// ---------------------------------------------------------------- Supabase
// Reads the whole number after "key": in a small JSON reply, or returns fallback.
long jsonLong(const String& body, const char* key, long fallback) {
  String k = String("\"") + key + "\"";
  int i = body.indexOf(k);
  if (i < 0) return fallback;
  i = body.indexOf(':', i + k.length());
  if (i < 0) return fallback;
  const char* p = body.c_str() + i + 1;
  while (*p == ' ') p++;
  if (*p != '-' && (*p < '0' || *p > '9')) return fallback;
  return strtol(p, nullptr, 10);
}

// One check-in. Returns true when Supabase answered properly.
bool poll() {
  String body = String("{\"p_token\":\"") + DEVICE_TOKEN + "\",\"p_done\":" + String(lastDoneId) +
                ",\"p_info\":\"rssi " + String((int)WiFi.RSSI()) + "\"}";

  http.setReuse(true);  // keep the secure connection open between checks (much faster)
  http.setConnectTimeout(5000);
  if (!http.begin(tls, String(SUPABASE_URL) + "/rest/v1/rpc/dropper_poll")) {
    Serial.println("Could not start the request");
    return false;
  }
  http.setTimeout(5000);
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  String reply = code > 0 ? http.getString() : String();
  http.end();

  if (code != 200) {
    if (code > 0) Serial.printf("Supabase error %d: %s\n", code, reply.c_str());
    else Serial.printf("Connection error: %s\n", HTTPClient::errorToString(code).c_str());
    if (code == 404) Serial.println("  -> Run supabase/field_release.sql in the Supabase SQL Editor.");
    if (code == 401 || code == 403) Serial.println("  -> DEVICE_TOKEN in secrets.h is wrong. Copy it again from Supabase.");
    return false;
  }

  long id = jsonLong(reply, "id", -1);
  long age = jsonLong(reply, "age", 0);
  long match = jsonLong(reply, "match", 0);
  if (id < 0) {
    Serial.printf("Unexpected reply: %s\n", reply.c_str());
    return false;
  }

  if (lastSeenId < 0) {
    // First contact since power-up: never replay a release from before we were switched on
    lastSeenId = id;
    Serial.printf("Connected to Supabase. Waiting for the Release button (last release was #%ld).\n", id);
  } else if (id > lastSeenId) {
    lastSeenId = id;
    if (age > MAX_AGE_S) {
      Serial.printf("Release #%ld is %ld s old, skipped.\n", id, age);
    } else {
      Serial.printf("Release #%ld for match %ld\n", id, match);
      releaseBalls("website");
      lastDoneId = id;
      pollNow = true;  // tell the staff page straight away
    }
  }
  return true;
}

// ---------------------------------------------------------------- main
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("GRC ball release starting");

  pinMode(LED_PIN, OUTPUT);
  setLed(false);
  pinMode(TEST_BUTTON_PIN, INPUT_PULLUP);

  servoBegin();
  servoAngle(CLOSED_ANGLE);

  if (strcmp(DEVICE_TOKEN, "paste-the-token-here") == 0)
    Serial.println("WARNING: DEVICE_TOKEN in secrets.h has not been filled in yet.");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // answer faster
  wifiMulti.addAP(WIFI_SSID, WIFI_PASSWORD);
  if (strlen(WIFI_SSID_2) > 0) wifiMulti.addAP(WIFI_SSID_2, WIFI_PASSWORD_2);

  // Encrypted (HTTPS) connection without checking Supabase's certificate.
  // Keeps setup simple; the device token still has to match.
  tls.setInsecure();
}

void loop() {
  // Test: pin 0 connected to GND (or BOOT pressed) opens the gate, even without Wi-Fi
  if (digitalRead(TEST_BUTTON_PIN) == LOW) {
    delay(30);
    if (digitalRead(TEST_BUTTON_PIN) == LOW) {
      releaseBalls("test on pin 0");
      while (digitalRead(TEST_BUTTON_PIN) == LOW) delay(10);
    }
  }

  // Wi-Fi
  if (WiFi.status() != WL_CONNECTED) {
    if (online) {
      Serial.println("Wi-Fi lost, reconnecting...");
      tls.stop();
    }
    online = false;
    setLed(false);
    Serial.printf("Connecting to Wi-Fi \"%s\"...\n", WIFI_SSID);
    if (wifiMulti.run(8000) == WL_CONNECTED) {
      Serial.printf("Wi-Fi connected to \"%s\", signal %d dBm\n", WiFi.SSID().c_str(), WiFi.RSSI());
      pollNow = true;
    } else {
      Serial.println("Wi-Fi not found yet (it must be 2.4 GHz). Trying again...");
    }
    return;
  }

  // Ask Supabase for news
  if (pollNow || millis() - lastPoll >= POLL_MS) {
    pollNow = false;
    lastPoll = millis();
    if (poll()) {
      failures = 0;
      if (!online) {
        online = true;
        setLed(true);
      }
    } else if (++failures >= 3) {
      if (online) Serial.println("Lost contact with Supabase, retrying...");
      online = false;
      setLed(false);
      tls.stop();  // start a fresh secure connection next time
      delay(1000);
    }
  }
}
