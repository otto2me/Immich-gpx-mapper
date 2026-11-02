# Immich GPX Mapper

Eigenständige Weboberfläche zur Ergänzung von Immich-Alben um Tourdaten wie
Komoot-Link, GPX-Track, Tourart, Beschreibung, Kommentare, Wanderrichtung und
optionale Karten-/Höhenprofilbilder.

Die Anwendung zeigt Immich-Alben an und ergänzt sie um Tourbeschreibungen,
Komoot-Links, Wander- oder Fahrradtouren, Richtung, Distanz, Höhenmeter,
GPX-Tracks, optionale Bilder und Kommentare. Tourdaten werden in SQLite
gespeichert; Immich bleibt die Quelle für Alben und Fotos.

## Architektur

Ein einzelner Container enthält das TypeScript/Fastify-Backend und das statisch
gebaute SvelteKit-Frontend. Fastify liefert beides unter derselben Origin aus.
Der Immich-API-Key bleibt auf dem Server. Immich selbst läuft unverändert in
seinem bestehenden Compose-Projekt.

HTTPS wird vom Synology Reverse Proxy terminiert. Der Mapper läuft intern über
HTTP und bindet seinen Port standardmäßig nur an `127.0.0.1`.

## Voraussetzungen

- Node.js 26 LTS für lokale Entwicklung
- Docker Compose für den Containerbetrieb
- Immich-API-Key mit passenden Lese-Berechtigungen
- Ein langes, zufällig gewähltes App-Passwort (mindestens 12 Zeichen)
- Zugriff des Mapper-Containers auf das Docker-Netzwerk des Immich-Servers

## Lokal entwickeln

```sh
cp .env.example .env
npm install
npm run dev
```

Das Frontend ist unter `http://localhost:5173` erreichbar; `/api` wird an das
Backend auf Port 3000 weitergeleitet. `DATA_DIR` kann für lokale Entwicklung
auf ein beschreibbares Verzeichnis gesetzt werden.

## In den bestehenden Immich-Compose-Stack einbinden

1. Dateien dieses Projekts in einen Ordner auf dem Docker-Host legen.
2. `docker-compose.example.yml` als Service-Ausschnitt in die bestehende
   Immich-Compose-Datei übernehmen (oder separat mit `-f` verwenden).
3. `.env.example` nach `.env` kopieren und `IMMICH_API_KEY` sowie ein eigenes,
   zufälliges `APP_PASSWORD` setzen. Für Foto-Links aus dem Browser außerdem
   `IMMICH_WEB_URL` auf die für Browser erreichbare Immich-Adresse setzen
   (z. B. `https://immich.example.org` oder `http://NAS-IP:8212`). `.env`
   niemals committen.
4. Falls nötig `IMMICH_API_URL` und `IMMICH_DOCKER_NETWORK` auf die Namen des
   eigenen Immich-Stacks anpassen. Das externe Netzwerk muss bereits existieren.
5. Den Datenordner `immich-gpx-mapper-data` anlegen und bei Bedarf
   `config.example.json` dort als `config.json` ablegen.
6. sicherstellen, dass der Ordner für UID 1000 beschreibbar ist (z. B. per
   SSH auf dem Docker-Host mit `sudo chown -R 1000:1000 immich-gpx-mapper-data`).
7. Compose-Datei in denselben Stack aufnehmen und den Container starten. Das Image wird durch GitHub Actions nach GHCR veröffentlicht, sobald der Workflow auf `main` ausgeführt wurde:

   ```sh
   docker compose pull immich-gpx-mapper
   docker compose up -d immich-gpx-mapper
   ```

Für private GHCR-Pakete muss Docker vor dem Pull bei `ghcr.io` angemeldet sein. Für einen Stack auf einem NAS ohne Registry-Anmeldung das Paket in den GitHub-Paketeinstellungen auf öffentlich stellen.

Der Compose-Ausschnitt veröffentlicht `127.0.0.1:3000`. Im Synology DSM unter
**Systemsteuerung → Anmeldeportal → Erweitert → Reverse Proxy** eine Regel
einrichten:

- Quelle: HTTPS, deine Mapper-Domain und der gewünschte Port (meist 443)
- Ziel: HTTP, `127.0.0.1`, Port `3000`

In der Immich-Compose-Datei muss das externe Netzwerk den Namen haben, der in
`IMMICH_DOCKER_NETWORK` angegeben ist. Falls Compose dein Netzwerk z. B.
`immich_default` nennt, passt der Beispielwert. Beim Einfügen in eine andere
Compose-Datei muss außerdem `build.context` auf den geklonten Projektordner
zeigen.

Prüfen, ob der Container läuft:

```sh
curl http://127.0.0.1:3000/api/health
```

## Sicherheit und Daten

- `IMMICH_API_KEY` wird nur an den Backend-Prozess übergeben. Er gehört weder
  ins Frontend noch in Git.
- Schreibzugriffe erfordern das App-Passwort. Nach erfolgreicher Anmeldung wird
  ein HttpOnly-/SameSite-Cookie mit einer 12-stündigen Sitzung gesetzt. Sitzungen
  werden im Arbeitsspeicher gehalten und enden bei einem Container-Neustart.
- Das App-Passwort wird ausschließlich über `APP_PASSWORD` konfiguriert und muss
  mindestens 12 Zeichen lang sein.
- Port 3000 ist standardmäßig nur am Loopback-Interface veröffentlicht. Die
  Synology Reverse-Proxy-Regel soll auf denselben Host zeigen.
- Das Verzeichnis `immich-gpx-mapper-data` ist persistent und muss für den
  Container-Benutzer (UID 1000 im Image) beschreibbar sein. Es enthält
  `mapper.sqlite` sowie GPX- und Bilddateien.
- Für Backups das zusätzliche Verzeichnis `immich-gpx-mapper-backups` als
   `/backups` mounten und ebenfalls für UID 1000 beschreibbar machen. Der
   Compose-Ausschnitt setzt dafür `BACKUP_DIR=/backups`. Möglichst einen
   separaten NAS-Sicherungsordner verwenden, nicht das Upload-Verzeichnis.
- Die Anmeldung ist ein gemeinsames Passwort, keine individuelle
  Benutzerverwaltung. Verwende ein starkes, einzigartiges Passwort und betreibe
  den Dienst nur hinter HTTPS.

## Einstellungen und ZIP-Sicherungen

Nach der Anmeldung öffnet das Zahnrad oben die **Einstellungen**. Ohne
Anmeldung sind Seite und Verwaltungs-API gesperrt.

- **Teilen verfügbar:** blendet die Linkverwaltung ein/aus. Ausgeschaltet
   funktionieren auch vorhandene Freigabelinks nicht; nach erneutem Aktivieren
   funktionieren weiterhin gültige, nicht widerrufene Links wieder. Der normale
   offene Album-/Berichtszugriff bleibt unverändert.
- **Komoot-Karte und Höhenprofil:** wählt lokale Bilder oder Remote-Embed als
   Standard. Fehlen lokale Bilder, bleibt das vorhandene Remote-Embed verfügbar.
- **Automatische Sicherungen:** aus, alle 1–365 Tage, bei Änderungen oder beides.
   Standardmäßig ist die Automatik aus. Nach Änderungen über die Mapper-API
   wird nach 30 Sekunden ohne weitere Schreibvorgänge gesichert. Der laufende
   Container prüft den Zeitplan minütlich; nach einem Neustart werden überfällige
   Intervallsicherungen nachgeholt. Extern veränderte Dateien lösen keinen
   Dateisystem-Watcher aus.
- **Sicherungen behalten:** 1–365 ZIPs, einschließlich Sicherheitskopien vor
   Importen. Ältere Mapper-ZIPs werden erst nach erfolgreicher neuer Sicherung
   entfernt. Andere Dateien im Sicherungsordner werden nicht gelöscht.
- **Jetzt sichern** erzeugt unabhängig vom Zeitplan ein ZIP. Die Liste bietet
   Downloads und zeigt Zeitpunkt, Größe und Fehlerstatus.

Der Backup-Pfad wird über `BACKUP_DIR` festgelegt und auf der Seite angezeigt;
ohne diesen Wert gilt `DATA_DIR/backups`. Im Container ist das ein Container-
Pfad, keine direkt eingetragene NAS-Freigabe. Beispiel für Portainer:

```yaml
environment:
   BACKUP_DIR: /backups
volumes:
   - /volume1/docker/immich-gpx-mapper/data:/data
   - /volume1/backup/immich-gpx-mapper:/backups
```

Beide Hostpfade vorher anlegen und für Container-UID 1000 beschreibbar machen.
Backups enthalten einen konsistenten SQLite-Snapshot mit Touren, Kommentaren,
Berichten, Freigabelinks und Einstellungen, alle Dateien unter `uploads`
sowie die vorhandene Datei aus `CONFIG_FILE`. Umgebungsvariablen, `.env`,
Container-Passwort, Container-Image und Immich-Originalfotos werden nicht
gesichert. Deshalb Portainer-Stack/Umgebungsvariablen und Immich separat sichern.
Die ZIPs sind nicht verschlüsselt und können einen API-Key aus `config.json`
enthalten; den NAS-Ordner entsprechend schützen.

### Wiederherstellen nach Neuinstallation

1. Einen kompatiblen Mapper-Stand installieren und Daten-/Backup-Ordner mounten.
2. `APP_PASSWORD` und die benötigten Immich-Umgebungsvariablen erneut setzen.
3. Anmelden, **Einstellungen → Sicherung importieren** öffnen und das ZIP wählen.
4. `WIEDERHERSTELLEN` eingeben und den Austausch ausdrücklich bestätigen.
5. Nach erfolgreichem Import den Container neu starten und erneut anmelden.
    Eine wiederhergestellte Dateikonfiguration wird erst beim Neustart geladen;
    gesetzte Umgebungsvariablen haben weiterhin Vorrang.

Das ZIP wird vor dem Austausch auf Format, Dateipfade, Größen, Prüfsummen,
Datenbankschema und verknüpfte Uploads geprüft. Es muss zur aktuellen
Programmversion passen. Maximale ZIP-Größe: 1 GiB; entpackt: 4 GiB und
20.000 Einträge. Vor einem gültigen Import wird der aktuelle Stand zusätzlich
als `mapper-safety-...zip` gesichert. Ohne diese Sicherheitskopie wird nicht
importiert. Während des Austauschs sind API-Zugriffe kurz gesperrt; danach
werden alle Mapper-Sitzungen ungültig. Ein Journal unterstützt die Bereinigung
oder Rücknahme unterbrochener Dateitausche beim nächsten Start.

Backups ersetzen keine zusätzliche Kopie auf einem anderen Datenträger.

## Nutzung

1. Öffne die Mapper-Adresse. Die Alben werden direkt aus Immich geladen.
2. Wähle ein Album oder öffne einen Deep-Link mit `/?album=<Album-ID>`.
3. Melde dich mit `APP_PASSWORD` an, um Tourdaten zu bearbeiten, Dateien
   hochzuladen und Kommentare zu schreiben.
4. GPX-Dateien werden auf der OpenStreetMap-Karte dargestellt. Für die
   Kartendarstellung benötigt der Browser Zugriff auf die OpenStreetMap-Kacheln.

Georeferenzierte Fotos aus dem Immich-Album erscheinen als anklickbare Marker
auf der GPX-Karte. Die Albumfotos lassen sich über **Albumfotos** ein- und
ausklappen. Ein Klick öffnet das Foto im Immich-Album-Viewer; dafür muss
`IMMICH_WEB_URL` auf eine vom Browser erreichbare Immich-Adresse zeigen.

### Mapper-Einträge eines Albums löschen

Nach der Anmeldung steht neben dem Albumtitel ein kleines Papierkorb-Symbol
für **Mapper-Einträge löschen** zur Verfügung. Nach ausdrücklicher Bestätigung
werden sämtliche lokalen Touren,
Kommentare, der Reisebericht, Freigabelinks und zugehörige Uploads entfernt.
Das Immich-Album und seine Fotos werden nicht gelöscht und bleiben daher
auch in der Albumliste sichtbar. Andere Alben, globale Einstellungen und
vorhandene ZIP-Sicherungen bleiben erhalten. Ein späterer Import einer
älteren Sicherung kann die gelöschten Mapper-Einträge wiederherstellen.

### Mehrere Touren in einem Urlaubsalbum

Über **Tour anlegen** eine Tour mit Datum und Zeitzone hinzufügen. Je Album
ist eine Tour pro Tag möglich. Die **Übersicht** zeigt weiterhin alle Fotos;
die Datums-Tabs zeigen die jeweilige Tour mit eigenen GPX-Dateien, Bildern
und Kommentaren.

Bei genau einer Tour wird diese unter **Touren** direkt angezeigt; der
zusätzliche Übersichts-Tab entfällt. Bei mehreren Touren bleiben Übersicht
und Datums-Tabs erhalten. Zur Albumliste führt der Markenlink **Immich GPX
Mapper** oben links; ein zweiter Zurück-Button ist nicht nötig.

Die Footer-Version stammt lokal aus Git. Veröffentlichte Container zeigen
einen Release-Tag oder den kurzen Commit-Hash, nicht den Branchnamen `main`.
Die Korrektur wird in einem bestehenden Container erst nach dem nächsten
Image-Build und Update sichtbar.

Standardmäßig gehören alle Fotos des lokalen Tourtages zur Auswahl.
**Beginn** und **Ende** grenzen diese nach dem Aufnahmezeitpunkt ein; Beginn
ist inklusive, Ende exklusiv. **Tourdaten speichern** aktualisiert Galerie
und Kartenmarker gemeinsam. Die Zeitzone sollte zum Aufnahmeort passen,
nicht zwingend zum aktuellen Standort des Browsers. Zeitfenster über
Mitternacht werden noch nicht unterstützt. Immich-Alben werden dabei weder
aufgeteilt noch verändert.

Vorhandene Touren bleiben nach der automatischen Datenbankmigration als
**Ohne Datum** erhalten. Ein Datum kann nachträglich zugeordnet werden.
Fotos ohne gültigen Aufnahmezeitpunkt bleiben in der Übersicht sichtbar.
Vor einem produktiven Update das komplette Mapper-Datenverzeichnis sichern.

### Reisebericht schreiben

**Reisebericht** steht vor **Touren** und ist die Standardansicht eines Albums.
Gespeicherte Berichte sind ohne Anmeldung lesbar. Zum Bearbeiten anmelden
und **Bearbeiten** wählen. Der Bericht gilt für das gesamte Album,
unabhängig vom ausgewählten Tourtag. Direkte Tour-Links öffnen weiterhin
die angegebene Tour.

1. Berichtstitel und Einleitung eingeben.
2. Über **Kapitel hinzufügen** Abschnitte mit Titel, Datum und Text anlegen.
3. Optional eine Tour aus demselben Album verknüpfen.
4. Über **Fotos auswählen** einzelne Albumfotos hinzufügen. Die Auswahl ist
   paginiert und kann auf eine Tour eingegrenzt werden.
5. Bildunterschriften ergänzen und Kapitel oder Fotos mit den Pfeilen sortieren.
6. **Vorschau** zeigt den Bericht mit einer kompakten Fotoübersicht und
   Tourverweisen. Am Desktop stehen Fotos nebeneinander, mobil untereinander.
   Ein Klick öffnet das Foto in großer Ansicht in einem neuen Tab.
7. Mit **Speichern** den Bericht dauerhaft ablegen; die gespeicherte Version
   ist anschließend auch ohne Anmeldung sichtbar.

Fotos werden nur über ihre Immich-ID referenziert, nicht kopiert oder in
andere Alben verschoben. Textabsätze bleiben erhalten; HTML und Markdown
werden nicht als Formatierung ausgeführt. Entfernte Immich-Fotos stehen
auch dem Bericht nicht mehr zur Verfügung.

Bei veralteten Bearbeitungen aus einem zweiten Tab wird das Speichern mit
einem Konflikt abgewiesen, ohne den lokalen Text zu verwerfen. Vor dem
Neuladen einer gespeicherten Version gegebenenfalls den eigenen Text sichern.
Nur das Bearbeiten und Speichern erfordert die gemeinsame Mapper-Anmeldung.

### Reisebericht teilen

Nach der Anmeldung beim gespeicherten Bericht **Teilen** öffnen. Eine
Bezeichnung und optional eine Ablaufzeit in der lokalen Browserzeitzone
angeben, anschließend **Link erstellen** wählen. Der neue Link wird nur
einmal vollständig angezeigt und kann mit **Link kopieren** übernommen
werden. Ohne Zwischenablage-Unterstützung wird das Feld zum Kopieren markiert.
Später sind in der Liste nur Bezeichnung, Status und Zeitangaben verfügbar;
bei verlorenem Link einen neuen erstellen und den alten widerrufen.

Der Link zeigt die jeweils zuletzt gespeicherte Berichtsversion ohne
Bearbeitungswerkzeuge. Anmeldung ist zum Lesen nicht nötig. **Widerrufen**
deaktiviert genau diesen Link; eine gesetzte Ablaufzeit macht ihn ebenfalls
ungültig. Bereits geladene oder heruntergeladene Inhalte bleiben beim Empfänger.

**Wichtig:** Das ausdrücklich gewünschte offene Lesen bleibt bestehen.
Ein Widerruf sperrt nicht den normalen Zugriff auf das Album und seinen
Bericht. Diese Links sind daher keine Zugriffssperre für ansonsten private
Inhalte.

Zum externen Teilen die von den Empfängern erreichbare Mapper-Adresse im
Browser öffnen und dort den Link erzeugen. Ein Link mit `localhost` ist nur
auf dem eigenen Rechner nutzbar. Das Fragment `#share=...` muss vollständig
mitkopiert werden; der Linkschlüssel wird von der Anwendung per Header an
die Lese-API gesendet und in der Datenbank nur als Hash gespeichert.

Die Tourart (Wanderung oder Fahrradtour) lässt sich beim Bearbeiten eines Albums
festlegen. Sie wird gemeinsam mit den übrigen Tourdaten gespeichert.

Ein geteilter Komoot-Link zeigt die Tourseite, ist aber nicht selbst ein GPX-
Download. Falls Komoot für die Tour einen GPX-Export anbietet, lade die Datei
über Komoot herunter und anschließend im Mapper hoch.

Bei angemeldeten Mapper-Nutzern kann **Daten aus Komoot lesen** öffentliche
Angaben wie Tourart und Distanz auslesen. Der offizielle Komoot-Embed zeigt die
Karte und das Höhenprofil in der Vorschau und nach dem Speichern bei der Tour.
Diese Inhalte werden direkt von Komoot geladen, nicht lokal gespeichert. Die
erkannten Tourwerte werden erst nach Bestätigung übernommen und müssen
anschließend gespeichert werden. Komoot-Anmeldung und GPX-Downloads werden
nicht automatisiert abgerufen.

Mit **Karte und Höhenprofil lokal speichern** rendert der Mapper den öffentlichen
Komoot-Embed serverseitig und speichert zwei PNG-Screenshots im persistenten
`DATA_DIR/uploads`-Verzeichnis des Docker-Volumes. Anschließend lässt sich in
der Touransicht zwischen dem aktuellen Komoot-Embed und den lokalen Screenshots
umschalten. Für diesen Schritt benötigt der Container Chromium sowie
Internetzugriff auf Komoot. Die Tourdaten werden vor der Aufnahme gespeichert.
Für lokale Entwicklung muss Chromium installiert und sein Pfad optional über
`KOMOOT_CHROMIUM_PATH` gesetzt werden.

GPX-Dateien sind auf 20 MiB begrenzt. Für Vorschaubilder sind JPEG, PNG und WebP
bis 20 MiB erlaubt. Ein hochgeladenes Bild ersetzt das bisherige Bild derselben
Art.

Weitere Architekturdetails stehen in [docs/architecture.md](docs/architecture.md).

Die Footer-Version wird automatisch aus dem aktuellen Git-Stand (`git describe`)
ermittelt. Lokale Builds erledigen das direkt; beim Docker-Build übergibt der
oben gezeigte Compose-Aufruf denselben Wert an das Image. Getaggte Commits zeigen
den Tag und den Commit-Abstand, nicht getaggte Commits den Commit-Hash.
