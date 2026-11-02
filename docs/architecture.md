# Architektur-Konzept: Immich GPX Mapper

## Ziel

Der Mapper ergänzt Immich-Alben um Tour-Informationen: Komoot-Link, GPX-Datei,
Beschreibung, Kommentare, Wanderrichtung und optionale Komoot-Karten-/Höhenprofilbilder.
Immich bleibt die Quelle für Alben und Fotos; die Zusatzdaten werden separat
gespeichert.

## Architektur

```text
Browser ── HTTPS ──▶ Synology Reverse Proxy ── HTTP ──▶ Mapper-Container
                                                          ├─ Fastify REST-API
                                                          ├─ SvelteKit SPA
                                                          ├─ Immich API (serverseitig)
                                                          └─ /data (gemountet)
                                                               ├─ config.json
                                                               ├─ SQLite-Datenbank
                                                               └─ GPX- und Bilddateien
```

Es gibt einen zusätzlichen Docker-Dienst im bestehenden Immich-Compose-Projekt.
Das SvelteKit-Frontend wird beim Image-Build statisch erzeugt und vom selben
Fastify-Prozess wie die API ausgeliefert. Im Browser läuft das Frontend
clientseitig. Der Immich-API-Key bleibt ausschließlich im Container.

Der Synology Reverse Proxy terminiert HTTPS und leitet per HTTP an den Mapper
weiter. Ein eigener Nginx- oder TLS-Container ist nicht nötig. Der veröffentlichte
Mapper-Port sollte auf `127.0.0.1` beschränkt sein.

## Komponenten

### Fastify-Backend

- Node.js 26 LTS und TypeScript.
- Liefert die SPA und die `/api/`-Routen auf demselben Origin aus.
- Liest Immich-Alben und Assets über die Immich-API; der API-Key wird niemals
  an den Browser ausgegeben.
- Verwaltet Tour-Zusatzdaten, Kommentare und Uploads.
- Speichert Konfiguration, Datenbank und Uploads unter `/data`.

### SvelteKit-Frontend

- Eigenständige Oberfläche mit Deep-Link aus Immich; kein Patch/Fork des
  Immich-Webclients.
- Zeigt Immich-Alben sowie Formulare und Tourdetails.
- Leaflet mit `leaflet-gpx` stellt einen vorhandenen GPX-Track dar.
- Komoot-Link und GPX-Datei sind alternative oder kombinierbare Eingaben.
  Ohne GPX wird der Komoot-Link angezeigt; optionale Bilder dienen als Vorschau.

### Konfiguration und Persistenz

Immich-Konfiguration kann über `/data/config.json` und Umgebungsvariablen
erfolgen. Umgebungsvariablen haben Vorrang. Der API-Key und das App-Passwort
werden ausschließlich als geheime Compose-Umgebungsvariablen gesetzt und nicht
in Git eingecheckt. `APP_PASSWORD` ist erforderlich und muss mindestens 12
Zeichen lang sein.

Vorgesehene Konfigurationswerte:

- `IMMICH_API_URL`
- `IMMICH_API_KEY`
- `APP_PASSWORD`
- `DATA_DIR`
- `CONFIG_FILE`
- `PORT`

## Datenmodell

Tour-Zusatzdaten werden über die Immich-Album-ID zugeordnet:

```sql
CREATE TABLE tours (
  id TEXT PRIMARY KEY,
  immich_album_id TEXT NOT NULL UNIQUE,
  activity_type TEXT NOT NULL DEFAULT 'hike'
    CHECK(activity_type IN ('hike', 'bike')),
  komoot_link TEXT,
  gpx_file_path TEXT,
  description TEXT,
  direction TEXT,
  komoot_map_image_path TEXT,
  elevation_profile_image_path TEXT,
  distance_km REAL,
  elevation_gain_m REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  tour_id TEXT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  author TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Immich-Album- und Asset-Metadaten werden live über die Immich-API gelesen und
nicht in der Mapper-Datenbank dupliziert.

### Diskussionsstand: Mehrtag-Alben und Reiseberichte

Noch nicht umgesetzt. Fachlich bestätigt sind mehrere Touren je Album, aber
höchstens eine Tour je Kalendertag innerhalb dieses Albums. Mehrere Touren am
selben Tag werden nicht benötigt. Urlaubstage ohne Tour bleiben im Album
darstellbar. Jede Tour behält eine eigene Identität; Datum und Tabs dienen
der Zuordnung und Navigation.

Die aktuelle eindeutige Album-Zuordnung in `tours` müsste dafür migriert
werden. Bestehende Touren, Kommentare und Dateiverweise müssen erhalten
bleiben. Eine Tour könnte Titel, Datum, Beginn und Ende, GPX-Datei sowie
Komoot-Link enthalten.

Bestätigt ist eine zeitbasierte Fotozuordnung. Der bearbeitbare
Tour-Zeitraum bestimmt anhand des Aufnahmezeitpunkts, welche Fotos aus dem
zugehörigen Immich-Album in der Tour erscheinen. Beispielsweise würden bei
09:00 bis 15:30 Uhr die übrigen Tagesfotos nicht zur Tour gehören, aber im
Album erhalten bleiben. Standardmäßig ist der ganze ausgewählte Kalendertag
in der gewählten Zeitzone eingeschlossen; Beginn und Ende können bei Bedarf
über Uhrzeiten eingegrenzt werden. Eine Übernahme vorhandener GPX-Zeitangaben
als Vorschlag bleibt eine noch nicht beschlossene Zusatzoption und darf
manuell gewählte Zeiten nicht ungefragt überschreiben.

Die gewählte Zeitzone muss für Tour-Zeitraum und Fotozeitpunkt konsistent
sein. Fehlende Zeitangaben, manuelle Korrekturen, Zeiträume über Mitternacht
und die genaue Behandlung der Intervallgrenzen sind vor der Umsetzung zu
klären. Eine Tourauswahl muss Galerie und Kartenmarker gemeinsam filtern;
der Filter muss vor der Fotopaginierung greifen, nicht nur auf der gerade
geladenen Seite. Immich-Assets werden dabei nicht verändert.

Ein Reisebericht könnte auf Albumebene Texte, ausgewählte Immich-Fotos und
Tourverweise zu Kapiteln verbinden. Fotos würden referenziert, nicht in neue
Immich-Alben verschoben oder dupliziert. Vorschlag für die Reihenfolge:
zunächst das Mehrtouren-Modell mit Datumsnavigation, anschließend der darauf
aufbauende Bericht.

Bestätigte Anforderung für das Teilen: Ein Reisebericht soll ohne Anmeldung
über einen widerrufbaren Freigabelink lesbar sein. Der Link berechtigt nur
zum Lesen des freigegebenen Berichts und seiner ausdrücklich ausgewählten
Medien, nicht zum übrigen Album oder zu Schreibzugriffen. Bericht und
Medienabrufe benötigen dieselbe serverseitige Freigabeprüfung; nach dem
Widerruf sind weitere Abrufe zu verweigern. Bereits heruntergeladene Inhalte
lassen sich dadurch nicht zurückholen. Der bestehende gemeinsame API-Key
ist keine Zugriffskontrolle für einzelne Reiseberichte.

## Benutzer und Immich-Berechtigungen

Der aktuelle Betrieb verwendet einen serverseitigen `IMMICH_API_KEY`. Dieser
gehört zu dem Immich-Konto, das ihn erstellt hat; Immich beschränkt die
API-Antworten auf die Berechtigungen dieses Kontos. Das gemeinsame
`APP_PASSWORD` des Mappers übernimmt keine Immich-Anmeldung und unterscheidet
Mapper-Benutzer nicht. Alle Mapper-Benutzer sehen deshalb dieselben Alben und
Tourdaten, die für den konfigurierten API-Key erreichbar sind.

**Entscheidung für den Familienbetrieb:** Ein dediziertes Immich-Konto erhält
nur die gewünschten, gemeinsam genutzten Alben. Alle Familienmitglieder nutzen
dieselbe Mapper-Ansicht und sehen diese freigegebenen Alben. Das entspricht dem
aktuellen Modell mit einem serverseitigen API-Key. Für getrennte
Benutzerbereiche braucht es individuelle Mapper-
Identitäten und eine Zuordnung zu je einem benutzergebundenen Immich-API-Key.
API-Keys müssten serverseitig verschlüsselt und mit einem getrennt verwalteten
Schlüssel (z. B. Docker Secret) geschützt werden. Tourdaten und Kommentare
benötigen außerdem eine explizite Besitzer-/Freigabeprüfung; die Album-ID allein
isoliert Benutzer nicht.

## Komoot-Integration

Komoot-Links können als Tourreferenz gespeichert werden. Die Anwendung
implementiert keinen Komoot-Login und speichert keine Komoot-Zugangsdaten.
Öffentlich geteilte Tourseiten sind nicht gleichbedeutend mit einem GPX-Export.
GPX-Dateien werden derzeit manuell aus Komoot exportiert und anschließend in
den Mapper hochgeladen. Eine künftige automatisierte Anmeldung sollte nur auf
Basis einer von Komoot unterstützten offiziellen Integration ergänzt werden.

Der Button „Daten aus Komoot lesen“ lädt ausschließlich die öffentliche
Tourseite von `www.komoot.de` oder `www.komoot.com` serverseitig und zeigt
erkannte Tourart, Distanz und Beschreibung zunächst als Vorschlag an. Nutzer
übernehmen die Werte bewusst; der Import speichert nicht automatisch. Karte und
Höhenprofil werden über den offiziellen öffentlichen Komoot-Embed direkt von
Komoot angezeigt und nicht als Bilddateien kopiert. Für die Anzeige wird eine
validierte Tour-ID und, wenn vorhanden, der Freigabe-Token des öffentlichen
Links verwendet. Weiterleitungen werden begrenzt und auf die erlaubten
Komoot-Hosts geprüft; Zugangsdaten/Cookies werden nicht gesendet. Auf Wunsch
rendert das Backend den öffentlichen Embed mit Chromium und speichert Karte und
Höhenprofil als getrennte PNG-Dateien unter `DATA_DIR/uploads`. Das Docker-Image
enthält Chromium dafür. Die UI kann zwischen dem Embed und den lokalen Bildern
wechseln; das lokale Bild ist eine Momentaufnahme, keine live aktualisierte
Komoot-Ansicht.

Chromium navigiert direkt zum Embed, damit Komoot auf normalen Web-Speicher
zugreifen kann. Im GPU-losen Alpine-Container ermöglichen das Paket
`chromium-swiftshader` und explizite Software-WebGL-Startoptionen die Karte.
Die Aufnahme wartet bis zu 60 Sekunden je Warteoperation auf das endgültige
Komoot-Karten-Canvas statt auf das zuerst sichtbare Relief-Canvas. Sie hängt
nicht von globaler Netzwerkinaktivität ab; die Ressourcen-Allowlist bleibt
aktiv. Karte und Höhenprofil wurden im frisch gebauten Docker-Image über den
regulären Screenshot-Endpunkt erfolgreich aufgenommen und gespeichert.

## API-Skizze

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/albums` | Immich-Alben abrufen |
| `GET` | `/api/albums/:albumId` | Album inklusive Assets abrufen |
| `GET` | `/api/assets/:assetId/thumbnail` | Immich-Vorschaubild serverseitig abrufen |
| `GET` | `/api/tours/:albumId` | Tour-Zusatzdaten lesen |
| `PUT` | `/api/tours/:albumId` | Tourart und Tour-Zusatzdaten anlegen/ändern |
| `POST` | `/api/komoot/preview` | Öffentlich sichtbare Komoot-Metadaten als Vorschau lesen |
| `POST` | `/api/tours/:albumId/komoot-screenshots` | Öffentliche Komoot-Karte und Höhenprofil lokal als PNG aufnehmen |
| `POST` | `/api/tours/:albumId/gpx` | GPX-Datei hochladen |
| `GET` | `/api/tours/:albumId/gpx` | GPX-Datei für die Karte ausliefern |
| `POST` | `/api/tours/:albumId/images/:kind` | Komoot-Karte oder Höhenprofil hochladen |
| `GET` | `/api/tours/:albumId/images/:kind` | Hochgeladenes Bild ausliefern |
| `GET`/`POST` | `/api/tours/:albumId/comments` | Kommentare lesen/hinzufügen |
| `GET` | `/api/auth/session` | Anmeldestatus abrufen |
| `POST` | `/api/auth/login` | Mit gemeinsamem App-Passwort anmelden |
| `POST` | `/api/auth/logout` | Abmelden |

Der API-Key wird nur serverseitig an Immich gesendet. Alle schreibenden
API-Routen sind durch ein gemeinsames App-Passwort geschützt. Eine erfolgreiche
Anmeldung setzt ein HttpOnly-/SameSite-Session-Cookie; Sitzungen laufen nach
12 Stunden ab oder werden beim Neustart des Containers verworfen. Die Anwendung
hat keine individuelle Benutzerverwaltung.

Bodylose Anfragen wie `POST /api/auth/logout` senden keinen JSON-Inhaltstyp.
Der Frontend-Client setzt `application/json` nur bei einem vorhandenen,
nicht leeren JSON-Body; bei `FormData` bestimmt der Browser den
Multipart-Inhaltstyp einschließlich Boundary.

Die Tourart ist `hike` (Wanderung) oder `bike` (Fahrradtour). Vorhandene
SQLite-Datenbanken werden beim Start migriert; bestehende Touren erhalten den
Standardwert `hike`.

## Compose-Einbindung

Ein einzelner Service wird zur vorhandenen Immich-Compose-Datei hinzugefügt.
Er nutzt das Immich-Docker-Netzwerk für den Zugriff auf die Immich-API und
ein Host-Verzeichnis für persistente Daten. Siehe `docker-compose.example.yml`
und `README.md`.
