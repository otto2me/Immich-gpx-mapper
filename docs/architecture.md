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

Tour-Zusatzdaten haben eine eigene ID und werden über die Immich-Album-ID
zugeordnet. Je Album ist höchstens eine Tour pro Datum erlaubt:

```sql
CREATE TABLE tours (
  id TEXT PRIMARY KEY,
  immich_album_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  tour_date TEXT,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  start_time TEXT,
  end_time TEXT,
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

CREATE UNIQUE INDEX tours_album_date ON tours(immich_album_id, tour_date);
CREATE UNIQUE INDEX tours_album_undated ON tours(immich_album_id) WHERE tour_date IS NULL;

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

### Mehrtag-Alben und Reiseberichte

Umgesetzt sind mehrere Touren je Album, aber
höchstens eine Tour je Kalendertag innerhalb dieses Albums. Mehrere Touren am
selben Tag werden nicht benötigt. Urlaubstage ohne Tour bleiben im Album
darstellbar. Jede Tour behält eine eigene Identität; Datum und Tabs dienen
der Zuordnung und Navigation.

Die bisher eindeutige Album-Zuordnung in `tours` wird beim Start innerhalb
einer SQLite-Transaktion migriert. Bestehende IDs, Kommentare und
Dateiverweise bleiben erhalten. Vorhandene Touren erhalten zunächst kein
Datum und erscheinen als „Ohne Datum“. Das Datum kann später bewusst
zugeordnet werden. Vor dem produktiven Update das vollständige Datenvolume
sichern. Eine Tour enthält Titel, Datum, Zeitzone, optional Beginn und Ende,
GPX-Datei sowie Komoot-Link.

Bestätigt ist eine zeitbasierte Fotozuordnung. Der bearbeitbare
Tour-Zeitraum bestimmt anhand des Aufnahmezeitpunkts, welche Fotos aus dem
zugehörigen Immich-Album in der Tour erscheinen. Beispielsweise würden bei
09:00 bis 15:30 Uhr die übrigen Tagesfotos nicht zur Tour gehören, aber im
Album erhalten bleiben. Standardmäßig ist der ganze ausgewählte Kalendertag
in der gewählten Zeitzone eingeschlossen; Beginn und Ende können bei Bedarf
über Uhrzeiten eingegrenzt werden. Eine Übernahme vorhandener GPX-Zeitangaben
als Vorschlag bleibt eine noch nicht beschlossene Zusatzoption und darf
manuell gewählte Zeiten nicht ungefragt überschreiben.

Der Immich-Aufnahmezeitpunkt `fileCreatedAt` wird für den Vergleich in die
gewählte IANA-Zeitzone umgerechnet. Beginn ist inklusive, Ende exklusiv;
ohne Uhrzeiten gilt der gesamte lokale Kalendertag einschließlich seiner
Sommerzeitregeln. Zeitfenster über Mitternacht werden in dieser Version
abgewiesen. Fotos ohne verwertbaren Aufnahmezeitpunkt bleiben in der
Albumübersicht, werden jedoch keiner datierten Tour automatisch zugeordnet.
Manuelle Ausnahmen je Foto sind noch nicht umgesetzt.

Die Übersicht zeigt alle Albumfotos. Datums-Tabs wählen eine Tour; Galerie
und Kartenmarker verwenden denselben Zeitfilter. Das Backend liest dafür
bei Bedarf alle Metadatenseiten des Albums und filtert vor der Ausgabe der
Fotoseiten mit je 48 Einträgen. Der ungefilterte Albumzugriff bleibt paginiert.
Immich-Assets werden nicht verändert. GPX, Kartenbilder und Kommentare
gehören jeweils zur ausgewählten Tour. Tour-Deep-Links verwenden
`/?album=<Album-ID>&tour=<Tour-ID>`, eine explizite Übersicht
`/?album=<Album-ID>&view=overview`.

Ein Reisebericht verbindet auf Albumebene Titel, Einleitung und sortierte
Kapitel aus Datum, Text, ausgewählten Immich-Fotos mit Bildunterschriften
und optionalem Tourverweis. Kapitel und Fotos lassen sich unabhängig
sortieren und entfernen. Fotos werden nur referenziert, nicht kopiert oder
in andere Immich-Alben verschoben. Die Editoransicht ist von der
Lesevorschau getrennt. Texte werden als Klartext mit erhaltenen Absätzen
gerendert, niemals als ungeprüftes HTML.

```sql
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  immich_album_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  introduction TEXT NOT NULL DEFAULT '',
  chapters_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
```

Die Reihenfolge der validierten Kapitel und Fotos wird im JSON-Dokument
gespeichert. Jede Kapitel-ID ist innerhalb des Berichts eindeutig. Beim
Speichern werden Tour- und Fotozugehörigkeit zum Album serverseitig geprüft;
dafür werden erforderlichenfalls alle Immich-Metadatenseiten gelesen.
Gespeicherte Berichte sind ausdrücklich ohne Anmeldung lesbar. Nur das
Schreiben erfordert die vorhandene Mapper-Sitzung. Antworten verwenden
`Cache-Control: no-store`. „Reisebericht“ steht in der Albumauswahl vor
„Touren“ und ist die Standardansicht; direkte Tour- und Übersichtslinks
bleiben erhalten. Die Leseansicht ist auch für angemeldete Besucher zunächst
aktiv, Bearbeitungswerkzeuge erscheinen nur nach Anmeldung.

Neue Berichte senden Revision 0, vorhandene ihre zuletzt geladene Revision.
Eine erfolgreiche Speicherung erhöht die Version atomar. Eine veraltete
Bearbeitung erhält HTTP 409; der Editor behält den lokalen Entwurf und bietet
ein bewusstes Neuladen an. Eigene Navigationsaktionen fragen bei ungespeicherten
Änderungen nach, und ein `beforeunload`-Handler schützt beim Verlassen der Seite.
Während des Speicherns sind diese Navigationsaktionen gesperrt.

Grenzen der ersten Version: höchstens 100 Kapitel, 100 Fotos je Kapitel und
500 Fotoeinträge insgesamt; der Anfragebody ist auf 1.000.000 Bytes begrenzt.
Es gibt keinen HTML-/Markdown-Editor. Jede gespeicherte Version ist für
Mapper-Besucher lesbar, sowohl regulär als auch über einen aktiven Freigabelink.
Der Berichts-Deep-Link lautet
`/?album=<Album-ID>&view=report`.

### Freigabelinks im offenen Lesemodus

Bestätigte Entscheidung: Das offene Lesen bleibt bestehen. Ein Widerruf
deaktiviert den konkreten Freigabelink, nicht den normalen Album-/Berichtszugriff.
Die bisherigen allgemeinen Album- und Medien-Leserouten bleiben unverändert.
Dies ist keine tokenbasierte Zugriffssperre für sämtliche Berichtsinhalte.

```sql
CREATE TABLE report_shares (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX report_shares_report ON report_shares(report_id);
```

Erstellen, Auflisten und Widerrufen erfordern die Mapper-Sitzung. Eine
Freigabe referenziert einen bereits gespeicherten Bericht. Der zufällige
Schlüssel hat 32 Bytes Entropie und wird in SQLite ausschließlich als
SHA-256-Hash gespeichert. Der Klartext wird nur beim Erstellen zurückgegeben,
nicht in der Linkliste. Ein verlorener Link muss neu erstellt werden.

Der Browser erzeugt aus seinem Origin `/#share=<Schlüssel>`. Der Fragmentteil
wird nicht im HTTP-Anfragepfad an den Server geschickt. Der Reader sendet den
Schlüssel als `Authorization: Bearer ...` an `GET /api/shared-report`. Schlüssel
sollen weder in Logs noch in Dokumentation stehen. Die eigene Linkansicht
setzt Referrer-/Robots-Metadaten und zeigt keine Bearbeitungswerkzeuge.

Die Lese-API prüft den Hash, `revoked_at` und die optionale Ablaufzeit bei
jedem Abruf. Ungültige, abgelaufene und widerrufene Links erhalten identisch
HTTP 404. Antworten verwenden `Cache-Control: no-store`; die Link-Lese-API
setzt zusätzlich `X-Robots-Tag: noindex, nofollow`. Geliefert wird die aktuell
gespeicherte Berichtsversion mit ihren Tourverweisen, kein eingefrorener Stand.
Eine Freigabe erzeugt keinerlei Schreibberechtigung. Widerrufen ist idempotent
und prüft die Albumzugehörigkeit der Freigabe.

Beim Öffnen oder Neuladen eines widerrufenen Links wird der Bericht nicht
mehr angezeigt. Bereits beim Empfänger geladene oder gespeicherte Inhalte
lassen sich nicht zurückholen; ebenso bleiben die normalen offenen Medien-
und Albumrouten erreichbar. Ein zukünftiger ausschließlich linkgebundener
Modus müsste diese Routen gemeinsam absichern und wäre eine andere
Zugriffsregel als die aktuell gewählte.

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
| `GET` | `/api/albums/:albumId/tours` | Touren des Albums auflisten |
| `POST` | `/api/albums/:albumId/tours` | Tour mit Datum und Zeitzone anlegen |
| `GET` | `/api/albums/:albumId/report` | Gespeicherten Bericht ohne Anmeldung lesen |
| `PUT` | `/api/albums/:albumId/report` | Validierten Bericht mit Versionsprüfung speichern |
| `GET` | `/api/albums/:albumId/report/shares` | Linkmetadaten lesen; Anmeldung erforderlich |
| `POST` | `/api/albums/:albumId/report/shares` | Freigabelink erstellen; Schlüssel einmalig ausgeben |
| `POST` | `/api/albums/:albumId/report/shares/:shareId/revoke` | Link innerhalb seines Albums widerrufen |
| `GET` | `/api/shared-report` | Aktuellen Bericht für einen gültigen Bearer-Linkschlüssel lesen |
| `GET` | `/api/albums/:albumId/assets` | Fotoseite; optional nach `tourId` filtern |
| `GET` | `/api/albums/:albumId/map-markers` | Foto-Standorte; optional nach `tourId` filtern |
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

Tour-Ressourcen unterstützen `?tourId=<Tour-ID>`. Die ID wird stets zusammen
mit der Album-ID geprüft; eine fremde oder unbekannte Tour liefert 404.
Ohne ID bleiben alte Album-URLs kompatibel: eine undatierte Tour hat Vorrang,
ansonsten wird die früheste datierte Tour verwendet.

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
