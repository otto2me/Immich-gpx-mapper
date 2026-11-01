# Entwicklungsstand

## Projektumfang

Das Architekturkonzept wurde als Anwendung umgesetzt: Fastify-API, SQLite-
Persistenz, Immich-Album-/Thumbnail-Proxy, Tourverwaltung, Passwort-Sitzungen,
Kommentare, GPX- und Bild-Uploads sowie Svelte-Oberfläche mit GPX-Karte und
öffentlichem Komoot-Embed. Schreibzugriffe sind mit einem gemeinsamen
App-Passwort geschützt.

## Aktueller Auftrag

Karte und Höhenprofil des offiziellen Komoot-Embeds können als lokale
PNG-Screenshots im Docker-Datenvolume gespeichert und in der Touransicht
anstelle des Embeds angezeigt werden.

## Umsetzung

- Vite ermittelt lokal `git describe --tags --always --dirty`.
- Der Wert wird beim Frontend-Build als `__APP_VERSION__` eingebettet und im
  Footer hinter „Immich GPX Mapper“ angezeigt.
- Für Docker-Builds wird `APP_VERSION` als Build-Argument an Vite weitergegeben.
- Der dokumentierte Compose-Aufruf leitet den aktuellen Git-Stand automatisch
  über `APP_VERSION` an den Build weiter.
- Die Static-Auslieferung nutzt Wildcard-Routen, damit gebaute JS-/CSS-Dateien
  direkt statt der SPA-Fallback-HTML ausgeliefert werden.
- `@fastify/static` ist auf Version `10.1.8` aktualisiert. Der aktuelle
  Produktions-Audit meldet drei moderate Advisories in dessen Abhängigkeiten
  `glob`/`minimatch`; die aktuelle `@fastify/static`-Version erlaubt keine
  gepatchte `glob`-Version innerhalb ihrer deklarierten Abhängigkeit.
- Die geteilte Komoot-Seite ist öffentlich erreichbar und beschreibt
  „Nach Blick auf Völs am Schlern“ als Mountain-Bike-Tour. Zentrale Aktionen
  verlangen eine Anmeldung; einen direkten GPX-Download zeigt die öffentliche
  Seite nicht. Der Mapper akzeptiert deshalb weiterhin heruntergeladene GPX-
  Dateien als Upload, ohne private Komoot-Endpunkte zu umgehen.
- Komoot-Links auf `komoot.de` und `komoot.com` werden unterstützt. Beim
  End-to-end-Test deckte der bereitgestellte `.de`-Link eine zuvor fehlende
  Domain-Variante auf.
- Die Komoot-Seite beschreibt „Nach Blick auf Völs am Schlern“ als
  Mountain-Bike-Tour. Die öffentliche Seite zeigt keinen GPX-Download; für
  zentrale Aktionen verlangt Komoot eine Anmeldung. Es wird kein inoffizieller
  Login-/Download-Endpunkt angesprochen.
- Tourart `hike`/`bike` wird in SQLite gespeichert; vorhandene Datenbanken
  erhalten eine Migration mit Standardwert `hike`.
- Die UI bekommt die Tourart-Auswahl; Mobilheader und Kartenhöhe werden für
  schmale Ansichten angepasst.
- Der Tourart-End-to-end-Test bestätigte Migration bestehender Daten als
  Wanderung, Speichern als Fahrradtour, Akzeptanz des bereitgestellten
  `komoot.de`-Links und Zurückweisung ungültiger Tourarten.
- Responsive Browserprüfungen bei 390, 768 und 1280 Pixeln fanden keinen
  horizontalen Überlauf. Die Tourart lässt sich in der UI ändern.
- Immich verwendet aktuell genau den im Server konfigurierten API-Key. Das
  gemeinsame Mapper-Passwort bildet keine Immich-Benutzeridentität ab; alle
  Mapper-Benutzer sehen dieselben für diesen Key verfügbaren Alben. Optionen
  für gemeinsamen Zugriff und echte Benutzertrennung sind in
  `docs/architecture.md` beschrieben.
- Das Backend sucht für lokale Entwicklung `.env` sowohl im Backend-Ordner als
  auch im Projektstamm, damit der dokumentierte Root-`.env`-Ablauf im npm-
  Workspace funktioniert.
- Gewähltes Betriebsmodell: ein gemeinsames Familienkonto in Immich, dem nur
  gemeinsam gewünschte Alben freigegeben werden. Individuelle Mapper-
  Benutzerkonten sind dafür derzeit nicht erforderlich.
- Neue Komoot-Vorschau-Route und UI-Button: validierte öffentliche Tour-URL,
  authentifizierter POST, begrenzte HTML-Antwort und zeitlimitierter Abruf,
  keine Cookies oder Zugangsdaten. Erkannte Werte werden zunächst als
  Vorschau angezeigt und erst nach Klick ins Formular übernommen.
- Live-Test des bereitgestellten Links: Titel „Nach Blick auf Völs am
  Schlern“, Tourart `bike`, Distanz 31,1 km und öffentliche Komoot-Karte
  verfügbar. Die öffentlichen Seitendaten enthielten keine auslesbaren
  Höhenmeter; das UI zeigt das explizit an.
- Die Oberfläche wurde mit Vorschau, Übernahme, Linkwechsel sowie 390-, 768-
  und 1280-Pixel-Ansichten getestet; kein horizontaler Überlauf. Die
  Komoot-Vorschau bleibt extern, bis der Nutzer die lokalen Screenshots
  ausdrücklich erstellt.
- Nutzerentscheidung: Karte und Höhenprofil über den offiziellen Komoot-Embed
  anzeigen statt ein separates Höhenprofilbild aus einer nicht öffentlichen
  Schnittstelle zu extrahieren.
- Die Komoot-Vorschau und gespeicherte Touransicht verwenden den öffentlichen
  Embed (`profile=1`); Tour-ID und optionaler Share-Token werden nur nach
  strikter Host-/Pfadvalidierung in eine feste `www.komoot.com`-URL übernommen.
- Der Embed lädt Karte und Höhenprofil direkt von Komoot; er wird weder als
  lokales Bild gespeichert noch in Immich hochgeladen.
- Manuelle lokale Bild-Uploads bleiben als optionaler Fallback verfügbar.
- Angemeldete Nutzer können die Tourdaten speichern und Karte/Höhenprofil aus
  dem offiziellen Embed als zwei getrennte PNG-Dateien serverseitig aufnehmen.
  Beide Dateien liegen unter `DATA_DIR/uploads` im Docker-Volume; die Touransicht
  bietet danach eine Umschaltung zwischen Embed und lokalen Screenshots.
- Der Screenshot-Endpunkt rendert ausschließlich eine streng validierte
  Komoot-Tour mit Chromium. Nicht benötigte Browser-Anfragen werden blockiert;
  die Dateien werden erst nach erfolgreicher Aufnahme in der Datenbank gesetzt.
- Das Runtime-Docker-Image installiert Chromium für diesen optionalen Schritt.
- Isolierter API-End-to-end-Test mit dem geteilten Komoot-Link: Anmeldung,
  Screenshot-Erstellung, Ablage von genau zwei PNG-Dateien unter einem
  Test-`DATA_DIR/uploads` und Auslieferung beider Dateien als `image/png`
  waren erfolgreich. Testdaten wurden anschließend entfernt.
- Beim Ändern des Komoot-Links werden gespeicherte Screenshots entfernt, damit
  die lokale Ansicht nicht mehr zu einer anderen Tour gehört.
- Build von Frontend und Backend erfolgreich mit Node.js 26.
- Browserprüfung mit dem geteilten Link bestätigte, dass der Embed-Titel,
  Tourdaten und Höhenprofil-Karte geladen werden. Die offizielle Embed-Seite
  antwortete mit HTTP 200 und enthält die Profilkarte.

## Geänderte Dateien

- `frontend/vite.config.ts`
- `frontend/src/app.d.ts`
- `frontend/src/routes/+page.svelte`
- `frontend/src/lib/api.ts`
- `backend/src/komoot.ts`
- `backend/src/komoot-screenshots.ts`
- `backend/src/tours.ts`
- `backend/package.json`
- `package-lock.json`
- `docs/architecture.md`
- `docs/development-status.md`
- `README.md`
- `Dockerfile`
- `docker-compose.example.yml`

## Validierung

- Frontend- und Backend-Build waren mit Node.js 26 erfolgreich.
- Die Vite-Konfiguration wurde zusätzlich mit einem expliziten
  `APP_VERSION`-Buildwert ausgeführt.
- Der Standardbuild hat den Git-Stand `20111b7` in das Frontend eingebettet.
- Die Static-Auslieferung liefert JavaScript mit `application/javascript`
  statt der SPA-Fallback-HTML aus.
- Der Browser-Smoke-Test zeigt im Footer sichtbar „Immich GPX Mapper Version
  20111b7“.
- Ein zusätzlicher Build mit explizitem `APP_VERSION` war ebenfalls erfolgreich.
- API-Smoke-Tests waren für Health-Check, nicht angemeldete Schreibsperre,
  Anmeldung, Tourdaten, Kommentare und GPX-Upload/-Download erfolgreich.
- Komoot-Import-Test: angemeldeter Abruf erfolgreich; nicht angemeldeter
  Abruf liefert 401, nicht erlaubte URLs werden mit 400 zurückgewiesen.
- Der Produktionsbuild ist nach der Komoot-Import-Erweiterung erfolgreich.
- Der offizielle Komoot-Embed mit `profile=1` wurde für den bereitgestellten
  Tourlink im Browser geöffnet und im Album angezeigt.
- Der Screenshot-Endpunkt wurde mit einem isolierten Backend und temporärem
  Datenverzeichnis erfolgreich durchgetestet.
- Ein Container-Build war nicht möglich, da Podman in der Umgebung nicht
  installiert ist; der reguläre Frontend-/Backend-Build war erfolgreich.

## Ergebnis

Die commit-basierte Footer-Version ist implementiert und geprüft. Bei lokalen
Builds wird sie direkt aus Git ermittelt. Compose übergibt den Git-Stand beim
Docker-Build als `APP_VERSION`. Der lokale Testserver wurde nur zur Prüfung
gestartet.

## Noch offene Integrationsprüfungen

- Mit einer realen Immich-Instanz Alben, Albumdetails und Vorschaubilder prüfen.
- Den Container-Build in einer Umgebung mit Podman oder Docker prüfen.
- Für `@fastify/static` eine kompatible Aktualisierung oder einen sicheren
  Dependency-Override für die `glob`/`minimatch`-Advisories verifizieren.
