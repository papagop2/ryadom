// Импорт организаций Слюдянского района из OpenStreetMap (ODbL).
// Снимок собран через Overpass API по границе района; адреса уточнены
// обратным геокодированием Nominatim. Это дополнительный справочный слой:
// карточки без онлайн-записи, с обязательной ссылкой на OSM.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPool } from '../api/db.mjs';
import { SLYUDYANKA } from './import-2gis.mjs';
import { categoryOf } from './categories.mjs';

const FILE = new URL('./data/slyudyansky-osm.json', import.meta.url);

function clean(value, max) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function importOsm(pool, { city = SLYUDYANKA, file = FILE, verbose = true } = {}) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const client = await pool.connect();
  let places = 0;
  try {
    await client.query('begin');
    await client.query(
      `insert into cities (slug, name, region, lat, lng) values ($1, $2, $3, $4, $5)
       on conflict (slug) do update set name = excluded.name, region = excluded.region,
         lat = excluded.lat, lng = excluded.lng, is_active = true`,
      [city.slug, city.name, city.region, city.lat, city.lng]);

    for (const org of data) {
      if (!org.osm || !org.name || !Number.isFinite(Number(org.lat)) || !Number.isFinite(Number(org.lng))) continue;
      const lat = Number(org.lat);
      const lng = Number(org.lng);
      const rubrics = Array.isArray(org.rubrics) ? org.rubrics : [];
      const district = clean(org.district, 60) || 'Слюдянский район';
      const address = clean(org.address, 200) || district;
      const about = clean(org.about, 600) || rubrics.join(' · ') || 'Организация из OpenStreetMap';
      const category = categoryOf({ rubrics, tags: org.tags, name: org.name });
      const metadata = {
        rubrics,
        sites: org.sites ?? [],
        phones: org.phones ?? [],
        schedule: null,
        openingHours: org.openingHours ?? null,
        tags: org.tags ?? {},
        license: 'ODbL-1.0',
        source: 'osm',
        importedAt: new Date().toISOString(),
      };
      const sourceUrl = org.sourceUrl || `https://www.openstreetmap.org/${org.osm}`;
      await client.query(
        `insert into places (city, city_slug, partner_id, name, category, district, address, lat, lng,
            about, phone, is_published, source, source_id, source_url, source_reviews_url,
            source_rating, source_rating_count, metadata, image_url, photos)
         values ($1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10, true, 'osm', $11, $12, null, null, 0, $13::jsonb, null, '[]'::jsonb)
         on conflict (source, source_id) where source_id is not null do update set
           city = excluded.city, city_slug = excluded.city_slug, name = excluded.name,
           category = excluded.category, district = excluded.district, address = excluded.address,
           lat = excluded.lat, lng = excluded.lng, about = excluded.about, phone = excluded.phone,
           source_url = excluded.source_url, source_reviews_url = null, source_rating = null,
           source_rating_count = 0, metadata = excluded.metadata, image_url = null, photos = '[]'::jsonb`,
        [city.name, city.slug, clean(org.name, 120), category, district, address,
          lat, lng, about, org.phones?.[0] ? clean(org.phones[0], 40) : null,
          `osm:${org.osm}`, sourceUrl, JSON.stringify(metadata)]);
      places += 1;
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  if (verbose) console.log(`OpenStreetMap ${city.name}: ${places} организаций`);
  return { places, city: city.slug };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    const file = process.argv.find(part => part.startsWith('--file='))?.slice('--file='.length) || FILE;
    await importOsm(pool, { file });
  } finally { await pool.end(); }
}
