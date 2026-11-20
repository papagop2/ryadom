export type RoutePoint = { lat: number; lng: number };

export type RoadRoute = {
  points: [number, number][];
  distanceKm: number;
  durationMin: number;
  road: boolean;
};

const cache = new Map<string, RoadRoute>();

function straightRoute(from: RoutePoint, to: RoutePoint): RoadRoute {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  const km = Math.max(0.3, Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a))) * 1.35 * 10) / 10);
  return {
    points: [[from.lat, from.lng], [to.lat, to.lng]],
    distanceKm: km,
    durationMin: Math.max(4, Math.round(km / 24 * 60 + 3)),
    road: false,
  };
}

export async function roadRoute(from: RoutePoint, to: RoutePoint): Promise<RoadRoute> {
  const key = `${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  for (const base of ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car']) {
    try {
      const response = await fetch(`${base}/route/v1/driving/${path}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const data = await response.json();
      const route = data.routes?.[0];
      const coordinates = route?.geometry?.coordinates;
      if (!route || !Array.isArray(coordinates) || coordinates.length < 2) continue;
      const raw = coordinates.map(([lng, lat]: [number, number]) => [lat, lng] as [number, number]);
      const step = Math.max(1, Math.ceil(raw.length / 320));
      const points = raw.filter((_, index) => index % step === 0);
      if (points[points.length - 1] !== raw[raw.length - 1]) points.push(raw[raw.length - 1]);
      const value: RoadRoute = {
        points,
        distanceKm: route.distance / 1000,
        durationMin: Math.max(1, Math.ceil(route.duration / 60)),
        road: true,
      };
      if (cache.size > 80) cache.clear();
      cache.set(key, value);
      return value;
    } catch { /* пробуем следующий маршрутизатор */ }
  }
  return straightRoute(from, to);
}
