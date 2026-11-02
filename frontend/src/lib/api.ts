export type Album = {
  id: string;
  albumName: string;
  description?: string | null;
  albumThumbnailAssetId?: string | null;
  assetCount?: number;
  assets?: Asset[];
};

export type Asset = {
  id: string;
  type?: string;
  originalFileName?: string;
  fileCreatedAt?: string;
};

export type MapMarker = {
  id: string;
  lat: number;
  lon: number;
  city: string | null;
  state: string | null;
  country: string | null;
};

export type AlbumAssetPage = {
  items: Asset[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type Tour = {
  id?: string;
  title: string;
  date: string | null;
  timeZone: string;
  startTime: string | null;
  endTime: string | null;
  activityType: "hike" | "bike";
  komootLink: string;
  description: string;
  direction: string;
  distanceKm: number | null;
  elevationGainM: number | null;
  hasGpx: boolean;
  hasKomootMap: boolean;
  hasElevationProfile: boolean;
};

export type Comment = {
  id: string;
  author: string | null;
  text: string;
  created_at: string;
};

export type ReportPhoto = { assetId: string; caption: string };
export type ReportChapter = {
  id: string;
  title: string;
  date: string | null;
  text: string;
  tourId: string | null;
  photos: ReportPhoto[];
};
export type TravelReport = {
  id?: string;
  title: string;
  introduction: string;
  chapters: ReportChapter[];
  revision: number;
  updatedAt?: string;
};

export type ReportShare = {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type SharedReportData = { report: TravelReport; albumId: string; tours: Tour[] };

export type AppSettings = {
  sharingEnabled: boolean;
  komootDefault: "embed" | "local";
  backupMode: "off" | "interval" | "changes" | "both";
  backupIntervalDays: number;
  backupKeep: number;
};
export type BackupInfo = { name: string; size: number; createdAt: string; kind: "backup" | "safety" };
export type BackupStatus = { directory: string; operation: "backup" | "restore" | null; dirty: boolean; lastBackupAt: string | null; lastBackupName: string | null; lastError: string | null };
export type RestoreResult = { restored: boolean; safetyBackup: string; restartRequired: boolean; warning?: string };

export type KomootPreview = {
  title: string;
  description: string;
  activityType: "hike" | "bike" | null;
  distanceKm: number | null;
  elevationGainM: number | null;
  mapImageUrl: string | null;
  sourceUrl: string;
};

export function komootEmbedUrl(value: string) {
  try {
    const url = new URL(value);
    const tourId = url.pathname.match(/^\/(?:[a-z]{2}-[a-z]{2}\/)?tour\/(\d+)\/?$/i)?.[1];
    if (
      url.protocol !== "https:" ||
      !["www.komoot.de", "www.komoot.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      !tourId
    ) {
      return null;
    }

    const embed = new URL(`https://www.komoot.com/tour/${tourId}/embed`);
    const shareToken = url.searchParams.get("share_token");
    if (shareToken) embed.searchParams.set("share_token", shareToken);
    embed.searchParams.set("hl", "de");
    embed.searchParams.set("layout", "classic");
    embed.searchParams.set("profile", "1");
    embed.searchParams.set("line", "4f6814");
    return embed.toString();
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? `Anfrage fehlgeschlagen (HTTP ${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function tourResource(albumId: string, suffix = "", tourId?: string | null) {
  const path = `/api/tours/${encodeURIComponent(albumId)}${suffix}`;
  return tourId ? `${path}?${new URLSearchParams({ tourId })}` : path;
}

export const api = {
  publicConfig: () => request<{ immichWebUrl: string | null; sharingEnabled: boolean; komootDefault: "embed" | "local" }>("/api/config"),
  settings: () => request<{ settings: AppSettings; backup: BackupStatus }>("/api/settings"),
  saveSettings: (settings: AppSettings) => request<{ settings: AppSettings; backup: BackupStatus }>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  backups: () => request<{ items: BackupInfo[]; status: BackupStatus }>("/api/backups"),
  createBackup: () => request<BackupInfo>("/api/backups", { method: "POST" }),
  restoreBackup: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<RestoreResult>("/api/backups/restore", { method: "POST", body });
  },
  session: () => request<{ authenticated: boolean }>("/api/auth/session"),
  login: (password: string) =>
    request<{ authenticated: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password })
    }),
  logout: () =>
    request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),
  albums: () => request<Album[]>("/api/albums"),
  komootLinkedAlbums: () => request<string[]>("/api/tours/komoot-linked-albums"),
  album: (id: string) =>
    request<Album>(`/api/albums/${encodeURIComponent(id)}`),
  deleteAlbumData: (id: string) => request<{ deleted: boolean; tours: number; reports: number; files: number; warning?: string }>(
    `/api/albums/${encodeURIComponent(id)}/mapper-data`, { method: "DELETE", body: JSON.stringify({ confirm: true }) }
  ),
  albumMapMarkers: (id: string, tourId?: string | null) =>
    request<MapMarker[]>(`/api/albums/${encodeURIComponent(id)}/map-markers${tourId ? `?${new URLSearchParams({ tourId })}` : ""}`),
  albumAssets: (id: string, page: number, tourId?: string | null) =>
    request<AlbumAssetPage>(`/api/albums/${encodeURIComponent(id)}/assets?${new URLSearchParams({ page: String(page), ...(tourId ? { tourId } : {}) })}`),
  tours: (id: string) => request<Tour[]>(`/api/albums/${encodeURIComponent(id)}/tours`),
  report: (id: string) => request<TravelReport | null>(`/api/albums/${encodeURIComponent(id)}/report`),
  reportShares: (id: string) => request<ReportShare[]>(`/api/albums/${encodeURIComponent(id)}/report/shares`),
  createReportShare: (id: string, label: string, expiresAt: string | null) =>
    request<{ share: ReportShare; token: string }>(`/api/albums/${encodeURIComponent(id)}/report/shares`, {
      method: "POST", body: JSON.stringify({ label, expiresAt })
    }),
  revokeReportShare: (albumId: string, shareId: string) =>
    request<{ revoked: boolean }>(`/api/albums/${encodeURIComponent(albumId)}/report/shares/${encodeURIComponent(shareId)}/revoke`, { method: "POST" }),
  sharedReport: (token: string) => request<SharedReportData>("/api/shared-report", {
    headers: { authorization: `Bearer ${token}` }
  }),
  saveReport: (id: string, report: TravelReport) => request<TravelReport>(`/api/albums/${encodeURIComponent(id)}/report`, {
    method: "PUT", body: JSON.stringify(report)
  }),
  createTour: (id: string, title: string, date: string, timeZone: string) =>
    request<Tour>(`/api/albums/${encodeURIComponent(id)}/tours`, {
      method: "POST", body: JSON.stringify({ title, date, timeZone })
    }),
  tour: (id: string, tourId?: string | null) =>
    request<Tour | null>(tourResource(id, "", tourId)),
  saveTour: (id: string, tour: Tour, tourId?: string | null) =>
    request<Tour>(tourResource(id, "", tourId), {
      method: "PUT",
      body: JSON.stringify(tour)
    }),
  komootPreview: (url: string) =>
    request<KomootPreview>("/api/komoot/preview", {
      method: "POST",
      body: JSON.stringify({ url })
    }),
  captureKomootScreenshots: (albumId: string, url: string, tourId?: string | null) =>
    request<Tour>(tourResource(albumId, "/komoot-screenshots", tourId), {
      method: "POST",
      body: JSON.stringify({ url })
    }),
  comments: (id: string, tourId?: string | null) =>
    request<Comment[]>(tourResource(id, "/comments", tourId)),
  addComment: (id: string, author: string, text: string, tourId?: string | null) =>
    request<Comment>(tourResource(id, "/comments", tourId), {
      method: "POST",
      body: JSON.stringify({ author, text })
    }),
  upload: (id: string, kind: "gpx" | "komoot-map" | "elevation", file: File, tourId?: string | null) => {
    const body = new FormData();
    body.append("file", file);
    const path = kind === "gpx"
      ? tourResource(id, "/gpx", tourId)
      : tourResource(id, `/images/${kind}`, tourId);
    return request<{ uploaded?: boolean; fileName?: string }>(path, {
      method: "POST",
      body
    });
  }
};

export function initialAlbumTour(tours: Tour[], requestedId: string | null, overview: boolean): Tour | null {
  if (tours.length === 1) return tours[0];
  return overview ? null : tours.find((tour) => tour.id === requestedId) ?? null;
}

export function emptyTour(): Tour {
  return {
    title: "",
    date: null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    startTime: null,
    endTime: null,
    activityType: "hike",
    komootLink: "",
    description: "",
    direction: "",
    distanceKm: null,
    elevationGainM: null,
    hasGpx: false,
    hasKomootMap: false,
    hasElevationProfile: false
  };
}
