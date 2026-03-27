# v2.0.0 - Major Update: Season Stats, Playoffs, Dashboard Cards

## Neue Sensoren

### Statistik-Sensoren
- **Saison** (`sensor.adler_mannheim_season`) - W-L-OTL Bilanz, Punkte, Tore, Gegentore, Tordifferenz, Heim/Auswaerts-Bilanz, Streak, letzte 5 Ergebnisse, Siegquote
- **Playoff** (`sensor.adler_mannheim_playoff`) - Aktueller Serien-Stand, Gegner, Best-of, Einzelergebnisse, aktiv/beendet
- **Spielstatistik** (`sensor.adler_mannheim_game_stats`) - Schuesse, Faceoff%, Powerplay, Strafminuten, Saves, Zuschauerzahl

### Binary Sensoren
- **Spiel Live** (`binary_sensor.adler_mannheim_game_live`) - ON wenn ein Spiel gerade laeuft
- **Spieltag** (`binary_sensor.adler_mannheim_game_day`) - ON wenn heute Spieltag ist (inkl. Gegner und Anpfiff)
- **Adler fuehrt** (`binary_sensor.adler_mannheim_winning`) - ON wenn Adler im laufenden Spiel fuehrt

## Neue Dashboard Cards

### Scoreboard Card (SAP Arena Videowuerfel)
- Design inspiriert vom echten Videowuerfel der SAP Arena
- Automatischer Wechsel: Live-Scoreboard / Letztes Ergebnis / Naechstes Spiel
- **Tor-Alert Animation** bei Adler-Toren (nur Adler!) mit Spielerfoto
- **Klickbare Details**: Spielzeitachse mit Toren und Strafen, Countdown zum naechsten Spiel
- Live-Countdown bis Spielbeginn
- Responsive Design
- Automatische Entity-Erkennung

```yaml
type: custom:adler-mannheim-scoreboard
```

### Season Overview Card
- Saisonbilanz mit Punkte-Anzeige, W-L-OTL Record, Streak
- Farbiger W/L-Fortschrittsbalken
- Statistik-Grid: Tore, Gegentore, Differenz, Siegquote
- Heim/Auswaerts-Split + Form-Dots (letzte 5 Spiele)
- Playoff-Serie mit Fortschritts-Kreisen
- Spielstatistik mit Side-by-Side Balkendiagrammen

```yaml
type: custom:adler-season-overview
```

## Neue Events
- `adlermannheim_penalty` - Neue Strafe erkannt (Spieler, Vergehen, Minuten, Drittel, Zeit)
- `adlermannheim_period_end` - Drittel beendet (Drittel-Nummer)

## Verbesserungen
- Dashboard-Cards werden automatisch nach `/config/www/` kopiert (kein manuelles Kopieren mehr noetig)
- Zeitzonen-korrekte Anzeige aller Spielzeiten (UTC > lokale Zeitzone)
- Spielerfotos bei Tor-Details (von adler-mannheim.de)
- Logo-URLs in Sensor-Attributen fuer Team-Logos
- Dynamisches Polling: 30s live, 60s kurz vor Spiel, 5min nahe Spiel, 30min idle
- `is_adler_goal` Flag bei jedem Tor in den Sensor-Attributen

## Upgrade-Hinweise
- Nach dem Update: Home Assistant neu starten
- Einmalig Ressourcen registrieren (Einstellungen > Dashboards > Ressourcen):
  - `/local/adler-mannheim-scoreboard.js` (JavaScript-Modul)
  - `/local/adler-season-overview.js` (JavaScript-Modul)
- Browser-Cache leeren: Strg+Shift+R
- Neue Entities erscheinen automatisch unter dem "Adler Mannheim" Geraet
