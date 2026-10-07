# v3.0.2 - Anzeigetafel nach dem echten Videowuerfel

Gebaut gegen ein Foto des Wuerfels in der SAP Arena. Zum Design des neuen Wuerfels ist oeffentlich nichts veroeffentlicht, das Foto war also die einzige Quelle. Die beiden Runden davor lagen in zwei Punkten klar daneben.

## Was der Wuerfel macht, und die Karte jetzt auch

| Wuerfel | vorher in der Karte | jetzt |
|---------|---------------------|-------|
| Anzeigeleiste fast schwarz, als eigenes Panel abgesetzt | Keyvisual direkt hinter den Zahlen | eigenes Panel in `#0d1013`, Keyvisual nur noch in der Umgebung bei halber Deckkraft |
| Ziffern aufrecht | alles in Industry Black Italic | aufrechter Stack, Kursiv nur noch fuer Sekundaertext |
| Teamkuerzel klein ueber der Zahl | Kuerzel neben dem Wappen | `MAN` ueber `6`, gesperrt und gedaempft |
| keine Wappen in der Leiste | zwei grosse Wappen mittendrin | Wappen klein in der Kopfzeile |
| Uhr mittig, Zehntel in der Schlussminute | durchgehend `MM:SS` | unter 60 Sekunden `0.0`, die Karte taktet dafuer auf 100 ms |
| Strafe als `#75 - 0:15` | farbige Chips | schlichter Text aussen an der Leiste |
| drei Pillen unter der Uhr, roter Punkt darueber | gab es nicht | drei Drittel-Pillen, laufendes Drittel in Rot, roter Live-Punkt |

Der Wuerfel ist deutlich ruhiger als eine Dashboard-Karte sein will, und genau diese Zurueckhaltung war der fehlende Punkt.

## Zwei ehrliche Einschraenkungen

- **Die drei Pillen und der rote Punkt sind eine Deutung.** Was sie codieren, ist aus einem Foto nicht lesbar. Hier stehen sie fuer die drei Drittel, weil das die nuetzlichste Lesart ist.
- **Es gibt keinen aufrechten Industry-Schnitt.** Der Verein liefert nur `Industry-BlackItalic` und die dekorative `IndustryInc`-Familie aus. Die Ziffern laufen deshalb ueber einen Stack mit `IndustryInc Base` zuerst und solidem Fallback. CSS faellt pro Zeichen zurueck, kaputtgehen kann also nichts.

## Farben

Das Theme im Dashboard-Repo folgt derselben Logik: Navy mit Keyvisual als Untergrund, die Karten selbst fast schwarz. Vorher war es umgekehrt.
