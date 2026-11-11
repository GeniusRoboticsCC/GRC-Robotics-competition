// =====================================================================
// Copy this file in the same folder, rename the copy to  secrets.h
// and fill it in. secrets.h is ignored by git, so your Wi-Fi password
// and device token never end up on GitHub or the website.
// =====================================================================
#pragma once

// Wi-Fi the ESP32 joins at the venue. It must be 2.4 GHz and must not need
// a login web page. A phone hotspot works well.
#define WIFI_SSID       "your-wifi-name"
#define WIFI_PASSWORD   "your-wifi-password"

// Optional backup network (for example your phone hotspot). Leave "" if unused.
#define WIFI_SSID_2     ""
#define WIFI_PASSWORD_2 ""

// The token shown at the end of supabase/field_release.sql
#define DEVICE_TOKEN    "paste-the-token-here"
