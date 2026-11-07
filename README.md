# Wupa Akademie

Lernspiel und gemeinsames Wörterbuch für die Geheimsprache. Mehrere Leute melden sich mit Namen und PIN an, erweitern die Sprache gemeinsam und sehen, wer gerade online ist. Läuft auf Cloudflare Workers, ohne eigenen Server.

## Was drin ist

- Lernspiel mit Welten, XP, Herzen, Serien und Abzeichen
- Gemeinsames Wörterbuch: Wörter ergänzen, korrigieren, löschen, alles live bei allen
- Übersetzer Deutsch und Geheimsprache, mit direktem Ergänzen unbekannter Wörter
- Verlauf aller Änderungen mit "Rückgängig"
- Freunde online mit Aktivität ("knobelt am Code-Quiz")
- Fortschritt pro Person auf dem Server, auf jedem Gerät derselbe
- Export des Wörterbuchs als Tabelle (CSV)

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `app/app.html` | Die App. Dieselbe Datei läuft auch in Claude. |
| `app/shim.js` | Verbindet die App mit dem Server: Anmeldung, Datenbank, Live-Updates, Anwesenheit |
| `src/worker.js` | Cloudflare Worker und eine Durable Object mit SQLite. Sie hält alle Daten und Verbindungen. |
| `src/seed.js` | Die 51 Startwörter, werden nur beim ersten Start eingespielt |
| `scripts/build.mjs` | Baut `public/` aus der App |
| `scripts/smoke.mjs` | Prüft den laufenden Server (rund 30 Prüfungen) |

## Lokal ausprobieren

Du brauchst Node 20 oder neuer.

```bash
npm install
cp .dev.vars.example .dev.vars   # darin steht CLUB_CODE=wupa
npm run dev                      # öffnet http://127.0.0.1:8787
```

Zum Prüfen in einem zweiten Terminal: `npm run smoke`.
Zum Zurücksetzen der lokalen Daten den Ordner `.wrangler/` löschen.

## Online stellen

1. Kostenloses Cloudflare-Konto anlegen. Der Free-Plan reicht für Familie und Freunde.
2. Einmal anmelden: `npx wrangler login`
3. Veröffentlichen: `npm run deploy`. Wrangler zeigt am Ende die Adresse, zum Beispiel `https://wupa-akademie.<dein-name>.workers.dev`.
4. Den Clubcode festlegen: `npx wrangler secret put CLUB_CODE`. Erst dann kann sich jemand anmelden.

Eine eigene Adresse (zum Beispiel `wupa.deinedomain.de`) stellst du im Cloudflare-Dashboard unter Workers, Einstellungen, Domains und Routen ein.

## Automatisch bei jedem Push veröffentlichen (Cloudflare mit GitHub)

Ohne API-Token, direkt im Cloudflare-Dashboard:

1. Workers & Pages, Create, Import a repository. GitHub verbinden und dieses Repository wählen (Branch `main`).
2. Build command: `npm run build`. Deploy command: `npx wrangler deploy`. Der Worker-Name muss `wupa-akademie` sein.
3. Save and Deploy.
4. Beim Worker unter Settings, Variables and Secrets das Secret `CLUB_CODE` anlegen.

Ab jetzt veröffentlicht jeder Push auf `main` die neue Version. Daten und Clubcode bleiben dabei erhalten.

Der Clubcode liegt nicht in GitHub, sondern nur bei Cloudflare.

## Anmeldung und Freunde einladen

Wer mitmacht, gibt Clubcode, Namen und einen eigenen PIN ein (mindestens 4 Zeichen).

- Neuer Name: Die Person wird angelegt, der PIN gehört ab dann zu diesem Namen.
- Bekannter Name: Es klappt nur mit dem passenden PIN. So kann niemand unter dem Namen eines anderen einsteigen. Nach 5 falschen PINs ist der Name 10 Minuten gesperrt.
- Groß- und Kleinschreibung beim Namen ist egal.
- Das Gerät bleibt angemeldet. Fortschritt und Name wandern auf jedes Gerät mit.

Zum Einladen schickst du den Link und den Clubcode. Der Club fasst bis zu 60 Personen.

## Alle abmelden oder Code ändern

- Neuer Clubcode für alle, die sich neu anmelden: `npx wrangler secret put CLUB_CODE`
- Alle Geräte sofort abmelden (zum Beispiel wenn jemand den Club verlässt): `npx wrangler secret put CLUB_EPOCH` und irgendeinen neuen Wert eingeben, etwa `2`, später `3`. Danach muss sich jeder neu anmelden, mit Clubcode, Name und PIN.

Beides zusammen sperrt jemanden aus: neuer Clubcode und neuer `CLUB_EPOCH`-Wert, dann den neuen Code nur an die Übrigen geben.

## Datensicherung

Im Wörter-Heft gibt es "Als Tabelle speichern". Das sichert alle Wörter als CSV. Der Verlauf der letzten 200 Änderungen lässt sich im Wörter-Heft rückgängig machen.

## Grenzen

- Alle Mitglieder dürfen Wörter ändern und löschen. Das Rückgängig-Werkzeug fängt Fehler auf, eine Moderation gibt es nicht.
- Es gibt kein Passwort-Zurücksetzen. Wer seinen PIN vergisst, meldet sich unter einem neuen Namen an.
- Ein Server-Objekt bedient alle Mitglieder. Das passt für Familie und Freundeskreis, nicht für Tausende Leute.
- Gespeichert werden nur Name, PIN (verschlüsselt abgelegt), Fortschritt und Wörter. Keine E-Mail-Adressen.

## Entwicklung

`app/app.html` ist die einzige Quelle der App. Änderungen dort wirken auf beide Versionen: die in Claude und die auf Cloudflare. Nach Änderungen: `npm run check`, dann `npm run dev`.
