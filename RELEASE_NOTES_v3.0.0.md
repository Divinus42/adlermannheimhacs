# v3.0.0 - Spieluhr, Tabelle, Kader und alle Wettbewerbe

Die Integration hat bisher einen einzigen Endpunkt der Vereins-API gelesen. Diese Version nutzt fuenf, bringt die echte Spieluhr auf die Anzeigetafel und zaehlt die CHL endlich mit.

## Neue Sensoren

| Sensor | Entity | Inhalt |
|--------|--------|--------|
| Spieluhr | `sensor.adler_mannheim_clock` | Laufende Spielzeit aus dem Liveticker, Drittel, `elapsed_seconds` zum Weiterzaehlen in der Karte |
| Tabelle | `sensor.adler_mannheim_standings` | Komplette DEL-Hauptrunde, alle 14 Teams, Playoff-Linien mit Legende, Adler-Zeile separat |
| Wettbewerbe | `sensor.adler_mannheim_competitions` | Bilanz pro Wettbewerb (DEL, CHL, Playoffs, Testspiele) plus Pflichtspiel-Gesamtbilanz |
| Topscorer | `sensor.adler_mannheim_top_scorer` | Fuehrender Scorer, dazu die Top 10 mit Toren, Assists, Punkten und Foto |
| Torhueter | `sensor.adler_mannheim_goalie` | Torhueter mit der meisten Eiszeit, Fangquote, GAA, Shutouts |
| Kader | `sensor.adler_mannheim_roster` | 38 Kadereintraege nach Position gruppiert, Verletztenliste, Teamfoto |
| Aufstellung | `sensor.adler_mannheim_lineup` | Wer im Spiel nominiert war, nach Position und Rueckennummer |

## Erweiterte Sensoren

**Spielstatistik** (`sensor.adler_mannheim_game_stats`) liefert zusaetzlich Schuesse neben das Tor, Powerplay-Effizienz in Prozent, Unterzahltore, Tore und Schuesse pro Drittel, die Torhueter des Spiels mit Entscheidung und Paraden, die Schiedsrichter, die Spieler des Spiels, den Spielbericht als Link, Spieltag, Tabellenplaetze beider Teams sowie Livestream- und Ticketlink.

**Letztes / Aktuelles / Naechstes Spiel** liefern zusaetzlich Tabellenplatz beider Teams, Arena, Zuschauerzahl, Spieltag, Wettbewerbslogo, Ligafarbe sowie Ticket- und Livestreamlink. Tore tragen jetzt den Zwischenstand und ein Spielerfoto, Strafen die Rueckennummer und die Angabe, welches Team sie bekommen hat.

**Saison** (`sensor.adler_mannheim_season`) unterscheidet Siege nach regulaerer Zeit und nach Verlaengerung und ergaenzt die offizielle Tabellenzeile des Vereins als `official_*`-Attribute.

## Behoben

- **Logo-URLs waren doppelt praefixiert.** Das Detail-Endpoint liefert absolute S3-URLs, der Code hat trotzdem noch den Hostnamen davorgesetzt. Die Attribute `home_logo` und `away_logo` haben deshalb nie ein Bild geladen.
- **Die Spieluhr auf dem Scoreboard war fest auf `20:00` verdrahtet.** Sie kommt jetzt aus dem Liveticker, und die Karte zaehlt zwischen zwei Abfragen selbst weiter.
- **Die Strafzeit-Kaesten auf dem Scoreboard waren leere Platzhalter.** Sie zeigen jetzt Rueckennummer und Restzeit der laufenden Strafen, berechnet aus Strafzeitpunkt und Dauer.
- **Die Drittel-Erkennung in der Karte war falsch.** Bei vorliegendem zweiten Drittel sprang die Anzeige auf das dritte.
- **Die Saisonbilanz hat nur DEL-Spiele gezaehlt.** CHL-Spiele fehlten in jeder Zahl. Punkte unterscheiden jetzt ausserdem Sieg nach regulaerer Zeit (3) von Sieg nach Verlaengerung oder Penaltyschiessen (2).
- **Spielernamen in Aufstellung und Spieltorhuetern blieben leer.** Die Personenobjekte der API heissen nicht einheitlich: ein Torschuetze und ein bestrafter Spieler tragen `id`, die Aufstellung und die Torhueter eines Spielberichts tragen `playerid`, ein Offizieller `officialid`. Die Namensfunktion hat nur `id` akzeptiert und fuer die beiden anderen Formen still `None` geliefert.

## Polling

Der Koordinator hat einen kurzen Takt und pro Endpunkt eine eigene Sperrfrist, statt bei jedem Takt alles neu zu laden:

| Endpunkt | Sperrfrist |
|----------|-----------|
| Liveticker | 10 s im Spiel, 10 min sonst |
| Spielliste | 20 s im Spiel |
| Detail des laufenden Spiels | 20 s im Spiel |
| Detail von letztem und naechstem Spiel | 5 min im Spiel |
| Tabelle | 15 min |
| Teamwerte | 30 min |
| Kader | 6 h |

Der Takt selbst bleibt 10 s im Spiel, 60 s kurz davor, 5 min in der Stunde davor und 30 min sonst. Faellt ein Nebenendpunkt aus, behaelt der Koordinator die letzte Antwort, statt das ganze Update scheitern zu lassen.

> **Hinweis zur API:** Die Endpunkte liegen hinter BunnyCDN. Schneller abzufragen als der Cache umschlaegt bringt nichts, weil dieselben Bytes zurueckkommen. Die hier eingestellten Werte sind ein erster Ansatz und werden nach einer Messung im Livespiel nachgezogen.

## Karten

**Scoreboard** (`custom:adler-mannheim-scoreboard`) zeigt laufende Spieluhr, Strafzeiten, Tabellenplatz hinter den Teamkuerzeln, Schuesse aufs Tor, den letzten Torschuetzen und einen dritten aufklappbaren Bereich mit dem Teamvergleich als Balken, Arena, Zuschauerzahl und Schiedsrichtern. Die Sekundenanzeige aktualisiert nur noch die beweglichen Stellen, damit die Toranimation nicht mitten im Lauf neu aufgebaut wird.

**Saison** (`custom:adler-season-overview`) hat jetzt Kacheln pro Wettbewerb und drei Reiter: Form mit den letzten zehn Ergebnissen, Tabelle mit markierten Playoff-Linien, Spieler mit Topscorern und Torhuetern.

## Was die API nicht liefert

Zwei Grenzen, gegen echte Spielberichte geprueft, damit niemand danach sucht:

- **Die Aufstellung im Spielbericht hat keine Einzelwerte.** Tore, Assists, Plus/Minus, Schuesse und Bullys sind dort durchgehend null, im 6:1-Sieg genauso wie in der 1:4-Niederlage. Werte je Spieler kommen deshalb aus dem Team-Endpunkt (Saisonwerte), die Torhueterzahlen eines Spiels aus dem `goalies`-Array des Spielberichts, und das sind echte Zahlen.
- **Es gibt keine Gegner-Aufstellung.** Der Spielbericht liefert immer nur die Adler-Bank, zu Hause die Heimseite, auswaerts die Auswaertsseite.

## Spielerfotos

Fotos und Wappen kommen ueber `/jsonapi/image/{id}?width=200`. Ohne den Breitenparameter liefert der Endpunkt das Original, und das sind pro Spielerfoto mehrere Megabyte.

## Umstieg

Keine Handgriffe noetig, alle bisherigen Entities behalten ihre IDs und Attribute. Fuer die neuen Karten einmal den Browser-Cache umgehen, indem die Lovelace-Ressource einen neuen Versionsparameter bekommt (`/local/adler-mannheim-scoreboard.js?v=6`).
