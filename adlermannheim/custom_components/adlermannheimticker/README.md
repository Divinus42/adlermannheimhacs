# Adler Mannheim Integration für Home Assistant

Dieses Custom Component integriert Daten rund um **Adler Mannheim** in Home Assistant.  
Über die Integration können z. B. Spielergebnisse, Spielpläne oder andere relevante Daten als Sensoren eingebunden werden.

## 🔧 Installation

1. Stelle sicher, dass [HACS](https://hacs.xyz/) in deinem Home Assistant installiert ist.
2. Füge dieses Repository als **Custom Repository** in HACS hinzu:
   - Öffne HACS → Integrationen → Menü (⋮) → **Custom Repositories**
   - Repository-URL: `https://github.com/Divinus42/adlermannheimhacs`
   - Kategorie: `Integration`
3. Suche in HACS nach **Adler Mannheim Integration** und installiere sie.
4. Starte Home Assistant neu.

## ⚙️ Konfiguration

Nach der Installation kannst du die Integration über die `configuration.yaml` oder (zukünftig) über den UI-Konfigurationsfluss (`config_flow`) hinzufügen.

### Beispiel `configuration.yaml`

```yaml
sensor:
  - platform: adlermannheim
    team: "Adler Mannheim"
