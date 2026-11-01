import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const screenshotTimeoutMs = 30_000;
const maxScreenshotBytes = 8 * 1024 * 1024;
const allowedResourceHosts = new Set([
  "www.komoot.com",
  "www.komoot.de",
  "api.komoot.de",
  "d2exd72xrrp1s7.cloudfront.net",
  "tiles-api.maps.komoot.net",
  "a.tiles-api.maps.komoot.net",
  "b.tiles-api.maps.komoot.net",
  "c.tiles-api.maps.komoot.net"
]);

function isAllowedResourceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      allowedResourceHosts.has(url.hostname) ||
      url.hostname.endsWith(".komoot.com") ||
      url.hostname.endsWith(".komoot.de")
    );
  } catch {
    return false;
  }
}

function findChromiumExecutable() {
  const configuredPath = process.env.KOMOOT_CHROMIUM_PATH;
  if (configuredPath) {
    if (!existsSync(configuredPath)) {
      throw new Error("Der konfigurierte KOMOOT_CHROMIUM_PATH wurde nicht gefunden");
    }
    return configuredPath;
  }

  const candidates = [
    chromium.executablePath(),
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  return candidates.find(existsSync);
}

export async function captureKomootScreenshots(embedUrl: string) {
  const executablePath = findChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      "Kein Chromium gefunden. Im Docker-Image wird Chromium mitinstalliert; lokal KOMOOT_CHROMIUM_PATH setzen."
    );
  }

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    env: {
      ...process.env,
      HOME: process.env.DATA_DIR ?? "/data"
    },
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      deviceScaleFactor: 1,
      locale: "de-DE",
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      if (isAllowedResourceUrl(route.request().url())) {
        await route.continue();
      } else {
        await route.abort();
      }
    });

    await page.goto(embedUrl, {
      waitUntil: "commit",
      timeout: screenshotTimeoutMs
    });

    const mapCanvas = page.locator("canvas.maplibregl-canvas").first();
    const elevationProfile = page.locator("[data-activity-profile-card]");
    await mapCanvas.waitFor({ state: "visible", timeout: screenshotTimeoutMs });
    await elevationProfile.waitFor({ state: "visible", timeout: screenshotTimeoutMs });
    await page.waitForTimeout(1200);

    const mapImage = await mapCanvas
      .locator("xpath=../..")
      .screenshot({ type: "png", timeout: screenshotTimeoutMs });
    const elevationImage = await elevationProfile.screenshot({
      type: "png",
      timeout: screenshotTimeoutMs
    });
    if (mapImage.byteLength > maxScreenshotBytes ||
        elevationImage.byteLength > maxScreenshotBytes) {
      throw new Error("Komoot-Screenshot überschreitet die erlaubte Dateigröße");
    }

    return {
      mapImage: Buffer.from(mapImage),
      elevationImage: Buffer.from(elevationImage)
    };
  } finally {
    await browser.close();
  }
}
