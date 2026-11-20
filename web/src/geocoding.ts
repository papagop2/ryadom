export type GeoPlace = {
  label: string;
  address: string;
  name: string | null;
  kind: string | null;
  lat: number;
  lng: number;
};

const DEMO_PLACES: GeoPlace[] = [
  { label: 'улица Мира, 12', address: 'Демоград, улица Мира, 12', name: 'Студия «Форма»', kind: 'house', lat: 55.7601, lng: 37.6186 },
  { label: 'проспект Победы, 4', address: 'Демоград, проспект Победы, 4', name: 'Студия «Линия»', kind: 'house', lat: 55.7742, lng: 37.6011 },
  { label: 'улица Садовая, 3', address: 'Демоград, улица Садовая, 3', name: 'Мастерская на углу', kind: 'house', lat: 55.7585, lng: 37.6290 },
  { label: 'улица Речная, 8', address: 'Демоград, улица Речная, 8', name: 'Тихий час', kind: 'house', lat: 55.7490, lng: 37.6402 },
  { label: 'улица Южная, 21', address: 'Демоград, улица Южная, 21', name: 'Кухня на районе', kind: 'house', lat: 55.7402, lng: 37.6154 },
  { label: 'улица Северная, 15', address: 'Демоград, улица Северная, 15', name: 'Глаз да глаз', kind: 'house', lat: 55.7801, lng: 37.6103 },
  { label: 'Привокзальная площадь, 1', address: 'Демоград, Привокзальная площадь, 1', name: 'Вокзал', kind: 'train_station', lat: 55.7761, lng: 37.6551 },
  { label: 'Центральный рынок', address: 'Демоград, Центральный рынок', name: 'Рынок', kind: 'marketplace', lat: 55.7548, lng: 37.6212 },
  { label: 'Центр', address: 'Демоград, Центральная площадь', name: 'Центр', kind: 'square', lat: 55.7558, lng: 37.6173 },
];

const cache = new Map<string, GeoPlace[]>();
const DEMO = import.meta.env.VITE_DEMO === '1';

export async function searchAddress(query: string, citySlug?: string | null): Promise<GeoPlace[]> {
  const text = query.trim();
  if (text.length < 3) return [];
  if (DEMO) {
    const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const lower = normalize(text);
    return DEMO_PLACES.filter(place =>
      normalize(`${place.label} ${place.address} ${place.name ?? ''}`).includes(lower)).slice(0, 6);
  }
  const key = `${citySlug ?? ''}|${text.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const params = new URLSearchParams({ q: text });
  if (citySlug) params.set('city', citySlug);
  const response = await fetch(`/api/v1/geo/search?${params}`, { signal: AbortSignal.timeout(7000) });
  if (!response.ok) return [];
  const data = await response.json() as { items?: GeoPlace[] };
  const items = data.items ?? [];
  if (cache.size > 80) cache.clear();
  cache.set(key, items);
  return items;
}

export async function reverseAddress(lat: number, lng: number): Promise<GeoPlace | null> {
  if (DEMO) {
    let nearest: GeoPlace | null = null;
    let best = Infinity;
    for (const place of DEMO_PLACES) {
      const distance = Math.abs(place.lat - lat) + Math.abs(place.lng - lng);
      if (distance < best) { best = distance; nearest = place; }
    }
    return best < 0.08 ? nearest : null;
  }
  const response = await fetch(`/api/v1/geo/reverse?lat=${lat}&lng=${lng}`, {
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) return null;
  return await response.json() as GeoPlace;
}
