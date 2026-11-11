# Ball release: ESP32 + servo

Staff press **⬇ Release balls** on the staff page. Within about a second, an ESP32 on the field opens a servo gate, waits 1.5 seconds and closes it again. The staff page then shows **Released ✓**.

```
Staff phone (control.html) ──► Supabase ◄── ESP32 on Wi‑Fi ──► Servo gate
      Release balls             logs it      checks twice       opens, waits,
                                             a second           closes
```

You don't need a laptop at the field or a REV Control Hub. The ESP32 only needs power and Wi‑Fi with internet access.

Plan about **1–2 hours** the first time, most of it on wiring and getting the gate angles right.

---

## What you need

| Item | Notes |
|---|---|
| **ESP32 board: WEMOS LOLIN32 V1.0.0** | The board this guide is written for: ESP‑32 module, Micro‑USB, CP2102 USB chip, a RESET button but no BOOT button. If its two pin strips came loose, solder them on (pins pointing down) before wiring the servo. Other classic ESP32 boards also work; see `LED_PIN` in the program |
| **USB data cable** for the board | Some cables only charge. If no port appears in step 4, try another cable |
| **Servo** | A normal hobby servo (MG996R, MG90S…) or your REV Smart Robot Servo set to normal servo mode, *not* continuous rotation |
| **Servo power supply, 5–6 V, at least 2 A** | A 4×AA battery pack (6 V), a 5 V USB power bank with a USB‑to‑wire lead, or a 5 V/6 V adapter. Check your servo's voltage rating |
| **Breadboard and jumper wires** | A half-size breadboard, 3 male‑to‑male and 3 female‑to‑male jumpers (one extra for the pin‑0 test wire) |
| **Power for the ESP32** | Any USB phone charger or power bank |
| **2.4 GHz Wi‑Fi with internet** | A phone hotspot is the most reliable at a venue. The ESP32 can't use 5 GHz Wi‑Fi or Wi‑Fi that needs a login web page |

---

## Step 1: Set up the database (5 minutes, once)

1. Open **supabase.com**, then your project, then **SQL Editor** and **New query**.
2. Open `supabase/field_release.sql` from this folder, copy all of it, paste it in, and click **Run**.
3. The result at the bottom shows one row: **DEVICE_TOKEN (copy into secrets.h)**. Copy that long code; you need it in step 5.
   - If you lose it, run the file again and it shows the same token.

Running it again later is safe. It doesn't touch teams or scores.

---

## Step 2: Put the new website online

The **Ball release** panel is on the staff page's **Score** tab, under the match clock. It goes live once the updated files are pushed to GitHub, the same as earlier changes, and Vercel publishes them a minute later.

- Before step 1 is done, the panel says **Not set up yet**.
- After step 1, and before the ESP32 is running, it says **Dropper offline**.

---

## Step 3: Wire it up

> ⚠ **Do not power the servo from the ESP32.** A servo moving under load draws far more current than the board can give, which makes the ESP32 restart. Give the servo its own supply and join the grounds together.

Servo wire colours: **brown or black** = ground (−), **red** = power (+), **orange, yellow or white** = signal.

| From | To |
|---|---|
| Servo **red** | Servo supply **+** (5–6 V) |
| Servo **brown/black** | Servo supply **−** **and** an ESP32 **GND** pin |
| Servo **orange/yellow/white** | ESP32 pin **18** (right-hand side on the LOLIN32) |
| ESP32 USB socket | USB charger or power bank |

The **GND‑to‑GND** link between the servo supply and the ESP32 is required. Without it the servo twitches or doesn't move at all.

> ⚠ The LOLIN32's small **white plug** next to the USB socket is for a 3.7 V LiPo battery only. **Never plug the AA servo battery pack into it.**

*Bench test only:* a tiny SG90 servo with nothing attached can run from the board's `5V`/`VIN` pin while the board is on USB. Don't do this at the event.

---

## Step 4: Install the Arduino software (15 minutes, once)

1. Download **Arduino IDE 2** from **arduino.cc/en/software** and install it.
2. Open Arduino IDE. Go to **Tools → Board → Boards Manager…**, search for **esp32**, and install **"esp32 by Espressif Systems"**. The newest version is about a 1.9 GB download. On slow internet, choose version **2.0.17** first, which is about 830 MB; the program is written to work with both.
3. Plug the ESP32 into the PC with the USB cable.
4. Open **Tools → Port** and pick the new **COM** port, for example `COM5`.
   - **No new port?** The LOLIN32's USB chip is a **CP2102**, which needs the **Silicon Labs CP210x** driver:
     1. On **silabs.com**, search for **CP210x USB to UART Bridge VCP Drivers**. On the **Downloads** tab, get the **CP210x Universal Windows Driver** ZIP.
     2. Right-click the ZIP and choose **Extract All**. Then right-click **silabser.inf** and choose **Install** (on Windows 11, click **Show more options** first).
     3. Unplug the board and plug it back in. Device Manager now shows **Silicon Labs CP210x USB to UART Bridge (COM…)** under **Ports**.
   - Still nothing? Try another USB cable, since many only charge. On other boards with a **CH340** chip, install the **WCH CH340** driver instead.

No extra libraries are needed.

---

## Step 5: Open the program and fill in your details

1. In Arduino IDE: **File → Open…** and choose `esp32\ball_release\ball_release.ino` inside this folder.
2. Click the **secrets.h** tab at the top and fill in:
   ```cpp
   #define WIFI_SSID       "your-wifi-name"        // exactly as spelt, capitals matter
   #define WIFI_PASSWORD   "your-wifi-password"
   #define WIFI_SSID_2     ""                      // optional backup network, e.g. a phone hotspot
   #define WIFI_PASSWORD_2 ""
   #define DEVICE_TOKEN    "paste-the-token-here"  // the code from step 1
   ```
3. Save with **Ctrl+S**.

> **No secrets.h tab?** Click the **⋯** button at the right end of the tabs, choose **New Tab**, and name it `secrets.h`. Copy everything from the **secrets.example.h** tab into it, then fill it in.

`secrets.h` is ignored by git, so your Wi‑Fi password and token won't be uploaded to GitHub or the website. **Don't put them in any other file.**

**iPhone hotspot:** turn on **Maximise Compatibility** in **Settings → Personal Hotspot**. That switches the hotspot to 2.4 GHz.

---

## Step 6: Upload to the ESP32

1. Go to **Tools → Board → esp32** and choose **ESP32 Dev Module** (or **WEMOS LOLIN32**; both work).
2. Check that **Tools → Port** is still the ESP32's COM port.
3. Click the **→ Upload** button. It compiles for a minute or two, then writes to the board.
   - If it gets stuck on `Connecting……`: connect pin **0** to the **GND** pin next to it with a jumper wire, press **RESET**, click Upload again, and remove the wire once the percentages start. Press **RESET** when it's finished. (On boards with a BOOT button, hold **BOOT** instead.)
4. Open **Tools → Serial Monitor** and set the speed (bottom right) to **115200 baud**. Press the board's **RESET** button to restart it. You should see:
   ```
   GRC ball release starting
   Connecting to Wi-Fi "YourHotspot"...
   Wi-Fi connected to "YourHotspot", signal -52 dBm
   Connected to Supabase. Waiting for the Release button (last release was #0).
   ```
5. The board's **blue LED** (next to the RESET button) **turns on** when it's connected to Supabase. If it does the opposite, change `LED_ACTIVE_LOW` near the top of the program and upload again.

---

## Step 7: Set the gate angles

When it powers up, the servo goes to the **closed** position.

1. **Fit the arm:** with the servo powered and the arm off, push the servo arm (horn) onto the shaft so that the gate is shut in this position.
2. **Test:** touch a jumper wire across pin **0** and the **GND** pin next to it for a moment (on boards with a BOOT button, press BOOT). The gate should open for 1.5 seconds and close again. This test works without Wi‑Fi. Don't leave the wire connected while plugging in or pressing RESET, or the board starts in programming mode and waits.
3. **Adjust if needed:** change these lines near the top of `ball_release.ino`, then upload again:
   ```cpp
   const int CLOSED_ANGLE = 0;               // gate shut (0 to 180)
   const int OPEN_ANGLE = 90;                // gate open (0 to 180)
   const unsigned long HOLD_OPEN_MS = 1500;  // how long it stays open
   ```
   - **Servo buzzes or strains when closed:** move `CLOSED_ANGLE` a few degrees towards `OPEN_ANGLE`.
   - **Opens the wrong way:** swap the two numbers, for example `CLOSED_ANGLE = 90` and `OPEN_ANGLE = 0`.

---

## Step 8: Test from the website

1. Sign in on the staff page and open the **Score** tab. The **Ball release** panel should say **Dropper online**, with the Wi‑Fi strength.
2. Press **⬇ Release balls**, then **OK**.
3. The panel shows **Releasing… waiting for the dropper**. The gate opens and closes, and the panel then shows **Released ✓ Match N**.

Do this a few times with balls loaded, from the phone you'll use on the day.

---

## On the day

1. Switch on the servo supply, then plug in the ESP32. Within about 10 seconds the blue LED is on and the staff page says **Dropper online**.
2. Load the balls with the gate closed.
3. When the match starts, press **⬇ Release balls**. Every release is logged with the match number and who pressed it.

**If it says "Not confirmed by the dropper":**
- Check the blue LED, the power and the hotspot, then press **Release** again.
- Touching the test wire across pin 0 and GND releases by hand.
- Dropping the balls by hand also works.

**Safety built in:**
- After power-up the ESP32 never replays an old release.
- It ignores any release older than 20 seconds, so if the Wi‑Fi drops, balls never fall late in the middle of a match.
- Two presses within 3 seconds count as one.

**Data use:** under 10 MB per hour, which is fine on a phone hotspot.

---

## Troubleshooting

| Serial Monitor or staff page shows | Fix |
|---|---|
| No COM port in **Tools → Port** | Install the CP210x driver (step 4), and use a data USB cable |
| Upload stuck on `Connecting……` | Connect pin 0 to GND, press RESET, upload, then remove the wire (step 6) |
| Nothing happens after power-up, and the Serial Monitor shows `waiting for download` | Pin 0 was connected to GND at power-up. Remove the wire and press RESET |
| `secrets.h is missing` when compiling | Create the `secrets.h` tab (step 5) |
| `Wi-Fi not found yet (it must be 2.4 GHz)` | Check the name and password, including capitals. Use a 2.4 GHz network; on an iPhone, turn on Maximise Compatibility |
| `Supabase error 404` | Run `supabase/field_release.sql` (step 1) |
| `Supabase error 401` or `403` | The token in `secrets.h` is wrong. Copy it again from step 1 |
| `Brownout detector was triggered`, or the board restarts when the servo moves | The servo is drawing power from the ESP32. Give it its own supply and connect the GNDs (step 3) |
| Servo twitches or doesn't move | Check the GND‑to‑GND link and that the signal wire is on pin 18 |
| Staff page: **Not set up yet** | Run `supabase/field_release.sql`, then reload the page |
| Staff page: **Dropper offline** | The ESP32 isn't connected. Check the LED and the Serial Monitor |

**Changing the token** (for example if it was shared by accident): run this in the SQL Editor, then put the new token in `secrets.h` and upload again.
```sql
update public.field_devices set token = replace(gen_random_uuid()::text, '-', '') where name = 'dropper';
select token from public.field_devices where name = 'dropper';
```
