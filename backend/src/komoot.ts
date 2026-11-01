import type { FastifyInstance } from "fastify";

const allowedHosts = new Set(["www.komoot.de", "www.komoot.com"]);
const maxPageBytes = 2 * 1024 * 1024;
const requestTimeoutMs = 12_000;

export type KomootPreview = {
  title: string;
  description: string;
  activityType: "hike" | "bike" | null;
  distanceKm: number | null;
  elevationGainM: number | null;
  mapImageUrl: string | null;
  sourceUrl: string;
};

function isAllowedKomootUrl(url: URL) {
  return (
    url.protocol === "https:" &&
    allowedHosts.has(url.hostname) &&
    !url.username &&
    !url.password &&
    /^\/(?:[a-z]{2}-[a-z]{2}\/)?tour\/\d+\/?$/i.test(url.pathname)
  );
}

export function publicKomootEmbedUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!isAllowedKomootUrl(url)) return null;

  const tourId = url.pathname.match(/\/tour\/(\d+)\/?$/i)?.[1];
  if (!tourId) return null;
  const embedUrl = new URL(`https://www.komoot.com/tour/${tourId}/embed`);
  const shareToken = url.searchParams.get("share_token");
  if (shareToken) embedUrl.searchParams.set("share_token", shareToken);
  embedUrl.searchParams.set("hl", "de");
  embedUrl.searchParams.set("layout", "classic");
  embedUrl.searchParams.set("profile", "1");
  embedUrl.searchParams.set("line", "4f6814");
  return embedUrl.toString();
}

function decodeHtml(value: string) {
  return value
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, " ")
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number(decimal))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16))
    );
}

function readMetaTags(html: string) {
  const metadata = new Map<string, string>();
  const imageUrls: string[] = [];
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attributes = new Map<string, string>();
    const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    for (const match of tag.matchAll(pattern)) {
      attributes.set(
        match[1].toLowerCase(),
        decodeHtml(match[2] ?? match[3] ?? match[4] ?? "")
      );
    }

    const key = attributes.get("property") ?? attributes.get("name");
    const content = attributes.get("content");
    if (key && content) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "og:image") imageUrls.push(content);
      if (!metadata.has(normalizedKey)) metadata.set(normalizedKey, content);
    }
  }
  return { metadata, imageUrls };
}

function parseDistanceKm(description: string) {
  const match = description.match(/(\d+(?:[.,]\d+)?)\s*(km|mi|miles?)\b/i);
  if (!match) return null;
  const distance = Number(match[1].replace(",", "."));
  if (!Number.isFinite(distance)) return null;
  return Number((match[2].toLowerCase().startsWith("mi") ? distance * 1.609344 : distance).toFixed(1));
}

function parseActivityType(text: string): KomootPreview["activityType"] {
  if (/\b(mountain\s?bike|bicycle|cycling|bike|fahrrad|radfahren)\b/i.test(text)) {
    return "bike";
  }
  if (/\b(hike|hiking|walk|walking|wanderung|wandern|spaziergang)\b/i.test(text)) {
    return "hike";
  }
  return null;
}

function safeMapImageUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "tourpic-vector.maps.komoot.net"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function readHtml(response: Response) {
  if (!response.body) throw new Error("Komoot hat keine Seitendaten geliefert");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxPageBytes) {
      throw new Error("Die Komoot-Seite ist zu groß zum Auslesen");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchPublicPage(startUrl: URL) {
  let currentUrl = startUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        accept: "text/html",
        "user-agent": "Immich-GPX-Mapper/1.0 (public route metadata preview)"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) {
        throw new Error("Komoot hat zu oft weitergeleitet");
      }
      currentUrl = new URL(location, currentUrl);
      if (!isAllowedKomootUrl(currentUrl)) {
        throw new Error("Komoot hat auf eine nicht unterstützte Adresse weitergeleitet");
      }
      continue;
    }

    if (!response.ok) {
      throw new Error(`Komoot antwortet mit HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error("Komoot hat keine HTML-Tourseite geliefert");
    }
    return { html: await readHtml(response), finalUrl: currentUrl };
  }

  throw new Error("Komoot-Seite konnte nicht geladen werden");
}

export async function registerKomootRoutes(app: FastifyInstance) {
  app.post<{ Body: { url?: unknown } }>(
    "/api/komoot/preview",
    async (request, reply) => {
      const value = request.body?.url;
      if (typeof value !== "string" || value.length > 2048) {
        return reply.code(400).send({ message: "Bitte einen gültigen Komoot-Link angeben" });
      }

      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return reply.code(400).send({ message: "Bitte einen gültigen Komoot-Link angeben" });
      }
      if (!isAllowedKomootUrl(url)) {
        return reply.code(400).send({ message: "Unterstützt werden öffentliche Tour-Links von www.komoot.de und www.komoot.com" });
      }

      try {
        const { html, finalUrl } = await fetchPublicPage(url);
        const { metadata, imageUrls } = readMetaTags(html);
        const title = metadata.get("og:title") ?? "";
        const description =
          metadata.get("og:description") ?? metadata.get("description") ?? "";
        if (!title && !description) {
          return reply.code(422).send({
            message: "Komoot zeigt für diesen Link keine öffentlich auslesbaren Tourdaten"
          });
        }

        const pageTitle =
          html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
        const combined = `${title} ${description} ${decodeHtml(pageTitle)}`;
        const mapImageUrl = imageUrls.find((imageUrl) =>
          imageUrl.includes("tourpic-vector.maps.komoot.net")
        );
        const elevationMatch = combined.match(
          /(?:elevation gain|ascent|höhenmeter|hm)\s*[:|]?\s*(\d[\d.,]*)\s*(m|ft)\b/i
        );
        let elevationGainM: number | null = null;
        if (elevationMatch) {
          const parsed = Number(elevationMatch[1].replace(/[,.](?=\d{3}\b)/g, "").replace(",", "."));
          if (Number.isFinite(parsed)) {
            elevationGainM = Math.round(
              elevationMatch[2].toLowerCase() === "ft" ? parsed * 0.3048 : parsed
            );
          }
        }

        const preview: KomootPreview = {
          title: title.replace(/\s*\|\s*Komoot\s*$/i, "").trim(),
          description: description.trim(),
          activityType: parseActivityType(combined),
          distanceKm: parseDistanceKm(combined),
          elevationGainM,
          mapImageUrl: safeMapImageUrl(mapImageUrl ? decodeHtml(mapImageUrl) : undefined),
          sourceUrl: finalUrl.toString()
        };
        return preview;
      } catch (error) {
        request.log.warn({ err: error }, "Could not read public Komoot tour metadata");
        return reply.code(502).send({
          message: error instanceof Error
            ? error.message
            : "Komoot-Seite konnte nicht ausgelesen werden"
        });
      }
    }
  );
}
