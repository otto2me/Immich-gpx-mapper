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

export const api = {
  publicConfig: () => request<{ immichWebUrl: string | null }>("/api/config"),
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
  albumMapMarkers: (id: string) =>
    request<MapMarker[]>(`/api/albums/${encodeURIComponent(id)}/map-markers`),
  albumAssets: (id: string, page: number) =>
    request<AlbumAssetPage>(`/api/albums/${encodeURIComponent(id)}/assets?page=${page}`),
  tour: (id: string) =>
    request<Tour | null>(`/api/tours/${encodeURIComponent(id)}`),
  saveTour: (id: string, tour: Tour) =>
    request<Tour>(`/api/tours/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(tour)
    }),
  komootPreview: (url: string) =>
    request<KomootPreview>("/api/komoot/preview", {
      method: "POST",
      body: JSON.stringify({ url })
    }),
  captureKomootScreenshots: (albumId: string, url: string) =>
    request<Tour>(`/api/tours/${encodeURIComponent(albumId)}/komoot-screenshots`, {
      method: "POST",
      body: JSON.stringify({ url })
    }),
  comments: (id: string) =>
    request<Comment[]>(`/api/tours/${encodeURIComponent(id)}/comments`),
  addComment: (id: string, author: string, text: string) =>
    request<Comment>(`/api/tours/${encodeURIComponent(id)}/comments`, {
      method: "POST",
      body: JSON.stringify({ author, text })
    }),
  upload: (id: string, kind: "gpx" | "komoot-map" | "elevation", file: File) => {
    const body = new FormData();
    body.append("file", file);
    const path = kind === "gpx"
      ? `/api/tours/${encodeURIComponent(id)}/gpx`
      : `/api/tours/${encodeURIComponent(id)}/images/${kind}`;
    return request<{ uploaded?: boolean; fileName?: string }>(path, {
      method: "POST",
      body
    });
  }
};

export function emptyTour(): Tour {
  return {
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
