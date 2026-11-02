# Entwicklungsstand

## Projektumfang

Das Architekturkonzept wurde als Anwendung umgesetzt: Fastify-API, SQLite-
Persistenz, Immich-Album-/Thumbnail-Proxy, Tourverwaltung, Passwort-Sitzungen,
Kommentare, GPX- und Bild-Uploads sowie Svelte-Oberfläche mit GPX-Karte und
öffentlichem Komoot-Embed. Schreibzugriffe sind mit einem gemeinsamen
App-Passwort geschützt.

## Aktueller Auftrag

Mehrere Touren je Album mit Datumsnavigation, optionalen Zeitfenstern und
gemeinsamer Foto-/Kartenfilterung sind umgesetzt und lokal geprüft.
Der Reisebericht mit Kapitel-Editor und Lesevorschau ist ebenfalls umgesetzt
und lokal geprüft. Verwaltbare Freigabelinks mit optionaler Ablaufzeit und
Widerruf sind ebenfalls umgesetzt. Der normale Albumbericht bleibt bewusst
ohne Anmeldung lesbar.

## Einstellungen und ZIP-Backups

- Angemeldete Nutzer erreichen über das Zahnrad eine Einstellungsseite.
  Teilefunktion und lokale/Remote-Komoot-Standardansicht sind persistent.
  Vorhandene Links werden bei deaktiviertem Teilen serverseitig gesperrt;
  der normale offene Berichtszugriff bleibt bestehen.
- Streaming-ZIP mit SQLite-Snapshot, Uploads, optionaler Dateikonfiguration
  und SHA-256-Manifest. NAS-Ziel über `BACKUP_DIR`; Compose-Beispiel mountet
  einen separaten `/backups`-Ordner. Keine Immich-Originale oder `.env`-Dateien.
- Automatik: aus, Intervall von 1–365 Tagen, Änderungen oder Kombination.
  Änderungsbackups bündeln 30 Sekunden; Zeitprüfung minütlich. Konfigurierbare
  Aufbewahrung von 1–365 Mapper-ZIPs, einschließlich Import-Sicherheitskopien.
- Import mit expliziter Bestätigung, sicheren Pfaden, Größenbegrenzung,
  Prüfsummen-/Schema-/Referenzprüfung und zwingendem Sicherheitsbackup vorab.
  Wiederherstellung mit Transaktion, Dateijournal und Wiederanlaufprüfung.
  Nach erfolgreichem Import werden Sitzungen ungültig; Neustart erforderlich.
- Frontend-Build und Backend-Build erfolgreich. Insgesamt 13 Tests bestehen:
  Einstellungen, Zugriffsrechte, vollständiger ZIP-Roundtrip, Aufbewahrung,
  Scheduler, ungültige Archive, ZIP-Traversal, Wiederanlauf sowie bisherige
  Tour-/Berichts-/Freigabe-Regressionen.
- Isolierte Browserprüfung: anonyme Einstellungen-/Backup-GETs HTTP 401;
  Optionen gespeichert; ZIP erstellt und heruntergeladen; echte UI-Import-
  Bestätigung, Wiederherstellung der Werte und Abmeldung erfolgreich.
  Gesonderte künstliche Tourdaten bestätigen lokale und Remote-Voreinstellung
  sowie ausgeblendeten Teilebereich. Keine produktiven Daten überschrieben.
- Desktop bei 1280 und Mobil bei 390 Pixeln geprüft, keine überlaufenden
  Eingaben. Produktiver NAS-Mount und Berechtigungen müssen beim Deployment
  geprüft werden; der lokale Ordner ist kein Test des tatsächlichen NAS.
- Neue ZIP-Abhängigkeiten melden keine Produktions-Advisories. npm meldet
  weiterhin drei moderate Hinweise über `@fastify/static`/`glob`/`minimatch`;
  kein sachfremdes Downgrade oder erzwungenes Audit-Fix durchgeführt.

## Kompaktere Berichtsansicht

- Kapitelbilder stehen am Desktop in zwei Spalten, auf schmalen Bildschirmen
  bis 600 Pixeln in einer Spalte. Die Bildflächen sind auf 240 beziehungsweise
  220 Pixel Höhe begrenzt, statt Bilder einzeln bis 750 Pixel hoch zu zeigen.
- Bilder bleiben durch `object-fit: contain` vollständig sichtbar;
  Bildunterschriften stehen direkt darunter. Ein Klick öffnet die große
  Immich-Vorschau in einem neuen Tab. Eingebettete Tourkarten sind ebenfalls
  auf eine kompaktere Höhe begrenzt.
- Die Darstellung gilt gemeinsam für normale Berichts- und Linkansichten;
  gespeicherte Inhalte und die Bildauswahl werden nicht verändert.

## Freigabelinks: Umsetzung und Prüfung

- Linkverwaltung über **Teilen** bei einem gespeicherten Bericht:
  Bezeichnung, optionale Ablaufzeit, Erstellen, einmaliges Kopieren und Widerruf.
- Zufällige Linkschlüssel aus 32 Bytes werden nur als SHA-256-Hash gespeichert.
  Die Metadatenliste enthält weder Schlüssel noch Hash. Link-URLs verwenden
  den Fragmentteil; der Reader sendet den Schlüssel per Authorization-Header.
- Die Linkansicht zeigt die neueste gespeicherte Berichtsversion, ohne Login-
  und Bearbeitungswerkzeuge. Ungültige, abgelaufene und widerrufene Links
  erhalten dieselbe HTTP-404-Meldung; Antworten sind `no-store`.
- Ausdrücklich bestätigt: Offenes Lesen beibehalten. Widerruf deaktiviert
  nur diesen Link. Die normale Albumansicht und allgemeine Medienrouten
  bleiben unabhängig davon erreichbar; keine falsche private Freigabegarantie.
- Gesamtbuild und fünf Regressionstests erfolgreich. Die neue Suite prüft
  Hash-Speicherung, fehlende/ungültige Schlüssel, aktuelle Berichtsversion,
  Ablauf, Widerruf, wiederholten Widerruf, Albumzugehörigkeit und Schreibschutz.
- Browserprüfung: Link erstellt und erfolgreich kopiert, Lesen mit
  ausgelassener Sitzung HTTP 200; Linkansicht mit zwei Kapiteln und zwei Fotos
  ohne Editor. Linkverwaltung bei 390 Pixeln ohne horizontalen Überlauf.
  Nach UI-Widerruf zeigt derselbe Testlink nur die Ungültigkeitsmeldung,
  während die normale anonyme Album-Berichtsroute weiterhin HTTP 200 liefert.
- Keine Veröffentlichung oder Änderung an produktiven Immich-Daten durch
  diese lokale Prüfung. Externe Links müssen über eine erreichbare Mapper-
  Adresse erzeugt werden; localhost-Links sind nur lokal nutzbar.

## Reisebericht: Umsetzung und Prüfung

- Ein Bericht pro Album mit Titel, Einleitung und sortierten Kapiteln aus
  Datum, Text, Tourverweis und ausgewählten Fotos mit Bildunterschriften.
- Editor mit paginierter Fotoauswahl aus dem Album oder einer Tour,
  Kapitel-/Fotosortierung und Entfernen einzelner Einträge. Separate
  Lesevorschau mit großen Immich-Vorschaubildern und Links zur Touransicht.
- Persistenz in der neuen SQLite-Tabelle `reports`; bestehende Tourdaten
  werden nicht verändert. Bilder bleiben Referenzen auf Immich-Assets.
- Bericht ist ohne Anmeldung lesbar; Schreiben erfordert die gemeinsame
  Mapper-Sitzung. „Reisebericht“ steht vor
  „Touren“ und ist die Standardansicht; explizite Tour-Links bleiben erhalten.
- Bearbeitungswerkzeuge erscheinen nur nach Anmeldung. Beim An-/Abmelden
  wird die Berichtsansicht neu geladen, damit ausgeloggte Besucher nur die
  gespeicherte Version sehen, nicht einen verworfenen lokalen Entwurf.
- Serverseitige Prüfung von Kapitelstruktur, Grenzen sowie Albumzugehörigkeit
  der Touren und Fotos. Revisionsprüfung verhindert stilles Überschreiben
  durch einen zweiten Editor-Tab; bei Konflikt HTTP 409, lokaler Text bleibt.
- Nachfragen vor dem Verwerfen eigener Änderungen und Schutz über
  `beforeunload`; Navigation ist während des Speicherns gesperrt.
- Vier automatisierte Tests aus Tour- und Berichts-Suite bestehen. Zusätzlich
  geprüft: Kapitelreihenfolge und Bildunterschriften, Neustart-Persistenz,
  fremde Tour-/Foto-IDs, ungültige Daten und Grenzen, gleichzeitige Writes,
  Lesen ohne Anmeldung und nach Logout sowie abgewiesene Schreibzugriffe
  ohne gültige Sitzung.
- Browserprüfung mit realem Immich-Album und separater Testdatenbank:
  Bericht mit zwei Kapiteln und zwei Fotos gespeichert und neu geladen,
  große Bildvorschau (2558 Pixel Quellbreite), Tourwechsel und Abbrechen des
  Verwerfens erfolgreich. Eingegebene Script-Tags wurden als Text angezeigt,
  nicht ausgeführt. Die Test-Tags wurden anschließend wieder entfernt.
- Desktopvorschau bei 1280 Pixeln und Mobil-Editor bei 390 Pixeln geprüft;
  kein horizontaler Überlauf, Beschriftungen und Werkzeuge passen.
- Icon-Werkzeuge nutzen das gepflegte Paket `@lucide/svelte`. npm meldet
  weiterhin sechs niedrige Dependency-Advisories; kein erzwungenes Audit-Fix
  oder sachfremdes Dependency-Upgrade vorgenommen.
- Der offene Lesemodus bleibt auch nach Einführung der Freigabelinks erhalten.
  Ein ausschließlich linkgebundener Modus ist nicht Teil dieser Umsetzung.

## Mehrtag-Alben: Umsetzung und Prüfung

- Mehrere Touren pro Album mit Titel, Datum, IANA-Zeitzone und optionalen
  Beginn-/Endzeiten; höchstens eine Tour pro Album und Kalendertag.
- Übersicht für das gesamte Album und tastaturbedienbare Datums-Tabs.
  Ohne Uhrzeiten gilt der ganze lokale Tag. Beginn ist inklusive, Ende
  exklusiv; Zeitfenster über Mitternacht werden abgewiesen.
- Transaktionale SQLite-Migration erhält Tour-IDs, Kommentare und
  Upload-Verweise. Bestehende Touren erscheinen zunächst „Ohne Datum“ und
  können später datiert werden. Vor produktiven Updates das Datenvolume sichern.
- Alle Tour-Ressourcen prüfen die ausgewählte Tour gegen das Album.
  GPX-Dateien, Bilder und Kommentare sind zwischen den Touren getrennt.
- Fotos werden anhand ihres Aufnahmezeitpunkts in der gewählten Zeitzone
  gefiltert, bevor die Fotopaginierung erfolgt. Die Kartenmarker verwenden
  denselben Filter. Fotos ohne auswertbare Zeit bleiben in der Übersicht.
- Die Metadatenseiten eines Albums werden für datierte Touren vollständig
  gelesen. Bei sehr großen Alben entstehen dadurch zusätzliche API-Abrufe;
  ein Metadaten-Cache ist noch nicht implementiert.
- Frontend-/Backend-Gesamtbuild erfolgreich. Drei automatisierte Tests in
  `backend/test/tours.test.mjs` prüfen Migration mit älterem Schema,
  Zeitzonen/Sommerzeit/Intervallgrenzen sowie Tour-API, Schreibschutz,
  doppelte Tage, Datei-/Kommentartrennung und Fotopaginierung über 1.200 Assets.
- Browserprüfung mit realem Immich-Album und eigener Testdatenbank:
  22 Albumfotos, zweiter Tourtag ohne Fotos, eingegrenztes Zeitfenster mit
  vier Fotos und genau vier zugehörigen GPS-Markern. GPX-Upload erfolgreich.
- Tourauswahl bleibt nach Neuladen erhalten. Pfeiltasten wechseln die Tabs,
  ohne den Fokus zu verlieren. Desktop bei 1280 Pixeln und Mobilansicht bei
  390 Pixeln visuell geprüft; kein horizontaler Überlauf.
- Nicht in diesem Mehrtag-Schritt enthalten: öffentliche Berichtsfreigabe,
  automatische GPX-Zeitübernahme und manuelle Fotoausnahmen.

Tests nach einem Build ausführen:

```sh
npm run build
node --test backend/test/tours.test.mjs backend/test/reports.test.mjs backend/test/report-shares.test.mjs backend/test/settings.test.mjs backend/test/backups.test.mjs backend/test/admin.test.mjs
```

## Aktualisierung vom 02.11.2026

- Chromium öffnet den offiziellen Komoot-Embed direkt. Ein künstliches
  `about:blank`-Elternfenster führte zu einem verweigerten `localStorage`-Zugriff.
- Das Alpine-Runtime-Image installiert zusätzlich `chromium-swiftshader`.
  Explizite SwiftShader-Startoptionen ermöglichen WebGL ohne Container-GPU.
- Komoot zeigt zunächst ein vorläufiges Relief-Canvas und ersetzt es später
  durch die fertige Karte. Die Aufnahme wartet auf
  `canvas.maplibregl-canvas:not(.maplibregl-map canvas)` und das Höhenprofil.
  Das Zeitlimit je Warteoperation beträgt 60 Sekunden. Globale
  `networkidle`-Wartebedingungen und ein Vorladen der normalen Tourseite sind
  nicht erforderlich und führten zu unnötigen Zeitüberschreitungen.
- Ein zusätzlicher Komoot-API-Aufruf kann ohne Anmeldung HTTP 403 liefern,
  obwohl der Freigabelink die vollständige Karte zeigt. Diese Antwort allein
  belegt kein Freigabeproblem.
- Der vollständige Docker-Build war erfolgreich. Im frisch gebauten,
  isolierten Container lieferte der Screenshot-Endpunkt HTTP 201 nach rund
  elf Sekunden und speicherte Karte und Höhenprofil. Die Kartenaufnahme wurde
  auf sichtbare Strecke und Beschriftungen geprüft. Es wurden keine
  produktiven Immich-Daten verändert.
- Der Frontend-Request-Helper setzt `application/json` nur bei einem
  vorhandenen, nicht leeren Body und nicht bei `FormData`. Der bisherige
  bodylose Logout mit JSON-Inhaltstyp wurde von Fastify mit
  `FST_ERR_CTP_EMPTY_JSON_BODY` abgewiesen.
- Regressionstest mit dem tatsächlichen API-Client und Fastify: Logout HTTP
  200, Sitzung einschließlich altem Session-Cookie ungültig, JSON-Login und
  Multipart-Upload weiterhin korrekt. Frontend-Build und Editor-Diagnosen
  waren erfolgreich.
- Die Prüfungen bestätigen den lokalen Quellstand. Veröffentlichung und
  Aktualisierung eines Portainer-Containers müssen separat erfolgen.

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
- `backend/src/database.ts`
- `backend/src/tour-selection.ts`
- `backend/src/immich.ts`
- `backend/src/server.ts`
- `backend/test/tours.test.mjs`
- `backend/src/reports.ts`
- `backend/src/auth.ts`
- `backend/test/reports.test.mjs`
- `frontend/src/lib/ReportEditor.svelte`
- `frontend/src/lib/ReportSharing.svelte`
- `frontend/src/lib/SharedReport.svelte`
- `backend/test/report-shares.test.mjs`
- `backend/src/settings.ts`
- `backend/src/backups.ts`
- `backend/src/admin.ts`
- `backend/test/settings.test.mjs`
- `backend/test/backups.test.mjs`
- `backend/test/admin.test.mjs`
- `frontend/src/lib/SettingsPage.svelte`
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
- Der zunächst mangels Container-Runtime ausstehende Container-Test wurde
  inzwischen mit Docker Desktop erfolgreich nachgeholt; siehe Aktualisierung
  vom 02.11.2026.

## Ergebnis

Die commit-basierte Footer-Version, lokale Komoot-Screenshots und die
Logout-Korrektur sowie mehrere Touren pro Album mit zeitbasierter
Fotozuordnung und Reiseberichts-Entwürfe sind implementiert und geprüft.
Verwaltbare Freigabelinks sind umgesetzt; ihr Widerruf lässt den ausdrücklich
gewünschten normalen offenen Lesezugriff unverändert.

## Noch offene Integrationsprüfungen

- Den jeweils veröffentlichten Stand nach dem Image-Update in Portainer
  prüfen; lokale Tests ersetzen keine Prüfung des tatsächlich laufenden Images.
- Für `@fastify/static` eine kompatible Aktualisierung oder einen sicheren
  Dependency-Override für die `glob`/`minimatch`-Advisories verifizieren.
