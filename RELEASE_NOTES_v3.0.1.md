# v3.0.1 - Gameday-Optik, vollstaendige Tabellenbilanz

Optisch die groessere Aenderung: die beiden Karten tragen jetzt die echten Assets des Vereins statt erfundener Farben. Dazu zwei Datenkorrekturen.

## Karten im Gameday-Look

**Hintergrund ist das Keyvisual, das die API selbst benennt.** Jedes Spiel liefert eine `leaguebackgroundurl`, und der Verein haelt dafuer je eine Fassung pro Wettbewerb vor: Navy mit blauen Baendern und roten Akzenten fuer die DEL, Lila mit Pink fuer die Champions Hockey League. Die Karte zieht sich also automatisch das richtige an, statt einen Look fest verdrahtet zu haben. Darueber liegt ein diagonaler Abdunkler, weil das Visual links oben am dichtesten ist.

**Schrift ist die des Vereins.** `Industry Black Italic` fuer Spielstand, Teamkuerzel und Namen, `IndustryInc Base` fuer Beschriftungen, SAPs `72` fuer Text. Die Dateien liegen auf der Vereinsseite und werden mit `Access-Control-Allow-Origin: *` ausgeliefert, duerfen also direkt geladen werden. Es wird nichts kopiert.

**Neu: `adler-fonts.js`.** Ein `@font-face` in einer Karte gilt nur dort, wo die Karte steht, und in einem Shadow DOM gar nicht. Dieses Modul traegt die Schriften einmal dokumentweit ein, damit auch Markdown- und Kachelkarten sie nutzen koennen. Es wird wie die Karten nach `/config/www/` kopiert und als Lovelace-Ressource registriert:

| Ressource | Typ |
|-----------|-----|
| `/local/adler-fonts.js` | JavaScript-Modul |

**Groesse skaliert an der Kartenbreite**, nicht am Bildfenster (`container-type: inline-size`). Dieselbe Karte ist damit eine normale Dashboard-Karte und, in einer Panel-Ansicht, eine bildschirmfuellende Anzeigetafel. Zwei neue Optionen:

```yaml
type: custom:adler-mannheim-scoreboard
full_height: true    # fuellt die Hoehe, blendet Kacheln und Panels aus
show_details: false  # Kacheln auch ohne full_height ausblenden
```

**Aufbau wie eine Anzeigetafel**: Kopfzeile mit Wettbewerb, Spieltag und Halle, beide Wappen gross mit Kuerzel und Tabellenplatz, mittig der Spielstand mit der Uhr in einem abgesetzten Feld, darunter Strafzeiten links und rechts, Drittelergebnisse und Schuesse. Vor dem Spiel traegt die Paarung die Karte und der Countdown ist die grosse Zahl, nicht der Anstoss.

**Saisonkarte** mit demselben Keyvisual im Kopf, Kacheln je Wettbewerb und den Reitern Form, Tabelle und Spieler.

## Behoben

- **Die Tabellenbilanz summierte bei drei von vierzehn Teams nicht auf die gespielten Spiele**, und ihre Punkte passten nicht dazu. Der Feed fuehrt `overtimewins`, `overtimelosses` und `shootoutwins`, aber kein `shootoutlosses`, eine Penalty-Niederlage war also unsichtbar. Die fehlende Groesse wird jetzt als Rest der gespielten Spiele hergeleitet und gegen die veroeffentlichten Punkte gegengerechnet. Neu: `shootout_losses`, `wins_overtime`, `losses_overtime`, `record` im Format S-SV-NV-N und `record_reconciles` als Warnsignal, falls der Feed sich aendert.
- **`leaguebackgroundcolor` kam mal mit, mal ohne Raute.** Ein DEL-Spiel liefert `#00264D`, ein CHL-Spiel `400045`, und die blanke Form ist keine gueltige CSS-Farbe. Der Sensor normalisiert das jetzt.
- **Einzelne Kadereintraege tragen ein Randleerzeichen im Vornamen**, was zu Namen mit zwei Leerzeichen fuehrte. Die Namensteile werden jetzt ueber Whitespace zusammengesetzt statt verkettet.
- **Kartenversion** stand faelschlich auf 3.0.0, waehrend die ausgelieferte Karte schon 6.0.0 war. Beide Karten laufen jetzt gleichauf auf 8.0.0.

## Neue Attribute

`sensor.adler_mannheim_next_game` und die beiden Geschwister liefern zusaetzlich `league_background`, damit die Karte das Keyvisual nicht ueber den Wettbewerbsnamen erraten muss.

## Umstieg

Keine Handgriffe noetig, alle Entities behalten ihre IDs. Zwei Dinge einmalig:

1. `/local/adler-fonts.js` als Lovelace-Ressource vom Typ JavaScript-Modul eintragen.
2. Den Versionsparameter der beiden Kartenressourcen erhoehen, damit der Browser nicht die alte Fassung aus dem Cache nimmt.
