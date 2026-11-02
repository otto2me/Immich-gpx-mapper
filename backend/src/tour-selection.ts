import type { DatabaseSync } from "node:sqlite";
import type { Tour } from "./database.js";

function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

export function selectTour(database: DatabaseSync, albumId: string, query: unknown = {}) {
  const tourId = (query as { tourId?: unknown }).tourId;
  if (tourId !== undefined && (typeof tourId !== "string" || !tourId || tourId.length > 100)) {
    invalid("Ungültige Tourauswahl");
  }
  const tour = (tourId
    ? database.prepare("SELECT * FROM tours WHERE immich_album_id = ? AND id = ?").get(albumId, tourId)
    : database.prepare("SELECT * FROM tours WHERE immich_album_id = ? ORDER BY tour_date IS NOT NULL, tour_date, id LIMIT 1").get(albumId)
  ) as Tour | undefined;
  if (tourId && !tour) {
    throw Object.assign(new Error("Tour gehört nicht zu diesem Album oder wurde nicht gefunden"), { statusCode: 404 });
  }
  return tour;
}

export function parseTourSchedule(input: Record<string, unknown>, existing?: Tour) {
  const date = input.date === undefined ? existing?.tour_date ?? null :
    input.date === null || input.date === "" ? null : input.date;
  if (date !== null) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) invalid("Ungültiges Tourdatum");
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) invalid("Ungültiges Tourdatum");
  }
  const zone = input.timeZone ?? existing?.time_zone ?? "UTC";
  if (typeof zone !== "string" || !zone || zone.length > 100) invalid("Ungültige Zeitzone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    invalid("Ungültige Zeitzone");
  }
  function time(value: unknown, fallback: string | null) {
    if (value === undefined) return fallback;
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) invalid("Uhrzeit muss HH:MM entsprechen");
    return value;
  }
  const start = time(input.startTime, existing?.start_time ?? null);
  const end = time(input.endTime, existing?.end_time ?? null);
  if (!date && (start || end)) invalid("Für ein Zeitfenster ist ein Tourdatum erforderlich");
  if (end && end <= (start ?? "00:00")) invalid("Das Ende muss nach dem Beginn am selben Tag liegen");
  return { date, zone, start, end };
}

export function tourPhotoFilter(tour: Tour) {
  if (!tour.tour_date) return () => true;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tour.time_zone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  return (asset: { fileCreatedAt?: string | null }) => {
    if (!asset.fileCreatedAt) return false;
    const instant = new Date(asset.fileCreatedAt);
    if (!Number.isFinite(instant.getTime())) return false;
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}`;
    return date === tour.tour_date &&
      (!tour.start_time || time >= tour.start_time) &&
      (!tour.end_time || time < tour.end_time);
  };
}