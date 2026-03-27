# Adler Mannheim - Home Assistant Integration

[![HACS](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://hacs.xyz)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/Divinus42/adlermannheimhacs/releases)

Live-Spielstande, Saisonstatistiken und Playoff-Tracking der **Adler Mannheim** direkt in Home Assistant. Inklusive Dashboard-Cards im SAP Arena Videowuerfel-Design.

---

## Features

- **Live-Spielstaende** mit automatischer Erkennung (Polling alle 30s bei laufendem Spiel)
- **Tor-Alerts** als Events + Sensor fuer Automationen (nur Adler-Tore!)
- **Saisonstatistik** mit W-L-OTL-Bilanz, Toren, Siegquote, Streak
- **Playoff-Tracker** mit Serien-Stand und Einzelergebnissen
- **Spielstatistiken** (Schuesse, Faceoffs, Powerplay, Strafminuten)
- **Binary Sensoren** fuer Spieltag, Spiel-Live, Adler-fuehrt
- **2 Dashboard-Cards** die automatisch installiert werden:
  - **Scoreboard Card** im SAP Arena Videowuerfel-Design
  - **Season Overview Card** mit Saison, Playoffs und Spielstatistiken
- **Spielzeitachse** mit allen Toren und Strafen klickbar im Scoreboard
- **Countdown** zum naechsten Spiel
- **Dynamisches Polling** - alle 30s live, alle 30min ohne Spiel

---

## Installation

### Ueber HACS (empfohlen)

1. **HACS** oeffnen
2. **Integrationen** > **+ Erkunden & Herunterladen**
3. Nach **"Adler Mannheim"** suchen
4. **Herunterladen**
5. **Home Assistant neu starten**

### Manuell

1. Repository-Inhalt nach `custom_components/adlermannheim/` kopieren
2. Home Assistant neu starten

### Integration einrichten

1. **Einstellungen** > **Geraete & Dienste** > **+ Integration hinzufuegen**
2. Nach **"Adler Mannheim"** suchen
3. Bestaetigen - fertig!

---

## Dashboard einrichten

Die Dashboard-Cards werden **automatisch** nach `/config/www/` kopiert. Du musst nur einmalig die Ressourcen registrieren.

### Schritt 1: Ressourcen hinzufuegen

**Einstellungen** > **Dashboards** > **Drei-Punkte-Menue** > **Ressourcen**

| Ressource | URL | Typ |
|-----------|-----|-----|
| Scoreboard | `/local/adler-mannheim-scoreboard.js` | JavaScript-Modul |
| Season Overview | `/local/adler-season-overview.js` | JavaScript-Modul |

### Schritt 2: Cards hinzufuegen

Dashboard bearbeiten > **+ Karte hinzufuegen** > **Manuell** > YAML einfuegen:

**Scoreboard (Videowuerfel-Design):**
```yaml
type: custom:adler-mannheim-scoreboard
```

**Season Overview:**
```yaml
type: custom:adler-season-overview
```

> Nach dem Hinzufuegen der Ressourcen einmal **Strg+Shift+R** im Browser druecken.

---

## Sensoren

### Standard-Sensoren

| Sensor | Entity-ID | Beschreibung |
|--------|-----------|-------------|
| Letztes Spiel | `sensor.adler_mannheim_last_game` | Ergebnis, Tore, Strafen, Drittel-Ergebnisse |
| Aktuelles Spiel | `sensor.adler_mannheim_current_game` | Live-Spielstand mit Tor-Details |
| Naechstes Spiel | `sensor.adler_mannheim_next_game` | Datum, Uhrzeit, Gegner |
| Adler Tore | `sensor.adler_mannheim_adler_tore` | Anzahl Adler-Tore im aktuellen/letzten Spiel |
| Gegner Tore | `sensor.adler_mannheim_gegner_tore` | Anzahl Gegner-Tore |
| Tor Alert | `sensor.adler_mannheim_tor_alert` | Zaehler der erkannten Adler-Tore (fuer Automationen) |

### Statistik-Sensoren

| Sensor | Entity-ID | Beschreibung |
|--------|-----------|-------------|
| Saison | `sensor.adler_mannheim_season` | W-L-OTL Bilanz, Punkte, Tordifferenz |
| Playoff | `sensor.adler_mannheim_playoff` | Serien-Stand, Gegner, Einzelergebnisse |
| Spielstatistik | `sensor.adler_mannheim_game_stats` | Schuesse, Faceoffs, Powerplay, Saves |

### Binary Sensoren

| Sensor | Entity-ID | Beschreibung |
|--------|-----------|-------------|
| Spiel Live | `binary_sensor.adler_mannheim_game_live` | ON wenn ein Spiel gerade laeuft |
| Spieltag | `binary_sensor.adler_mannheim_game_day` | ON wenn heute ein Spiel stattfindet |
| Adler fuehrt | `binary_sensor.adler_mannheim_winning` | ON wenn Adler im laufenden Spiel fuehrt |

---

## Events fuer Automationen

| Event | Beschreibung | Daten |
|-------|-------------|-------|
| `adlermannheim_goal` | Tor gefallen | `is_adler_goal`, `scorer`, `scorer_jersey`, `assist1`, `assist2`, `period`, `time`, `goaltype` |
| `adlermannheim_game_start` | Spiel gestartet | `game_id`, `home_team`, `away_team`, `match_start` |
| `adlermannheim_game_end` | Spiel beendet | - |
| `adlermannheim_penalty` | Strafe ausgesprochen | `player`, `infraction`, `minutes`, `period`, `time` |
| `adlermannheim_period_end` | Drittel beendet | `period` |

---

## Beispiel-Automationen

### Licht bei Adler-Tor

```yaml
automation:
  - alias: "Adler Tor - Licht blinken"
    trigger:
      - platform: event
        event_type: adlermannheim_goal
        event_data:
          is_adler_goal: true
    action:
      - service: light.turn_on
        target:
          entity_id: light.wohnzimmer
        data:
          color_name: blue
          brightness: 255
      - delay: "00:00:03"
      - service: light.turn_on
        target:
          entity_id: light.wohnzimmer
        data:
          color_name: white
```

### Tor-Alert Sensor (State-Trigger)

```yaml
automation:
  - alias: "Adler Tor - via Sensor"
    trigger:
      - platform: state
        entity_id: sensor.adler_mannheim_tor_alert
    action:
      - service: notify.mobile_app
        data:
          title: "TOR! Adler Mannheim!"
          message: >
            {{ trigger.to_state.attributes.last_scorer }}
            ({{ trigger.to_state.attributes.last_time }})
```

### Spieltag-Benachrichtigung

```yaml
automation:
  - alias: "Spieltag Erinnerung"
    trigger:
      - platform: state
        entity_id: binary_sensor.adler_mannheim_game_day
        to: "on"
    action:
      - service: notify.mobile_app
        data:
          title: "Heute ist Spieltag!"
          message: >
            Adler Mannheim spielt heute gegen
            {{ state_attr('binary_sensor.adler_mannheim_game_day', 'opponent') }}
```

### Nanoleaf Gameday-Szene

```yaml
automation:
  - alias: "Gameday Nanoleaf"
    trigger:
      - platform: state
        entity_id: binary_sensor.adler_mannheim_game_live
        to: "on"
    action:
      - service: scene.turn_on
        target:
          entity_id: scene.adler_mannheim_gameday
```

---

## Scoreboard Card Optionen

```yaml
type: custom:adler-mannheim-scoreboard
# Optional: Explizite Entity-IDs (normalerweise automatisch erkannt)
entity: sensor.adler_mannheim_current_game
entity_next: sensor.adler_mannheim_next_game
entity_last: sensor.adler_mannheim_last_game
```

Die Card zeigt automatisch:
- **Live-Spiel**: Scoreboard mit animiertem LIVE-Indikator und Tor-Alert
- **Kein Spiel**: Letztes Ergebnis + Countdown zum naechsten Spiel
- **Klick auf letztes Spiel**: Spielzeitachse mit allen Toren und Strafen
- **Klick auf naechstes Spiel**: Detail-Info mit Countdown

---

## FAQ

**Die Card zeigt "KEINE SPIELDATEN"**
- Pruefe in Entwicklerwerkzeuge > Status ob die `sensor.adler_mannheim_*` Entities existieren und nicht `unavailable` sind
- Falls `unavailable`: Integration unter Einstellungen > Integrationen neu laden
- Falls Entity-IDs anders: Card mit expliziten Entity-IDs konfigurieren (siehe oben)

**Dashboard ist abgeschnitten**
- Die Card ist voll responsive. Bei sehr schmalen Spalten nutze eine volle Breite.

**Card wird nicht gefunden ("custom element not found")**
- Pruefe ob die Ressource korrekt registriert ist (Einstellungen > Dashboards > Ressourcen)
- Browser-Cache leeren: Strg+Shift+R

**Tor-Alert kommt nicht**
- Der Tor-Alert triggert nur bei **Adler-Toren**, nicht bei Gegentoren
- Der Alert wird erst bei **neuen** Toren ausgeloest (nicht rueckwirkend beim Laden)

---

## Lizenz

MIT License - siehe [LICENSE](LICENSE)
