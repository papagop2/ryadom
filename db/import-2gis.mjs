// Импорт снимка организаций и отзывов 2ГИС для пилотного города.
// Снимок сделан вручную из публичных страниц 2ГИС; в приложении он всегда
// подписан «2ГИС» и ведёт на исходную карточку. Это не официальный API.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPool } from '../api/db.mjs';

export const SLYUDYANKA = { slug: 'slyudyanka', name: 'Слюдянка', region: 'Иркутская область', lat: 51.659713, lng: 103.706825 };
const FILE = new URL('./data/slyudyanka-2gis.json', import.meta.url);

const FOOD = ['кафе', 'ресторан', 'кофейн', 'бар', 'суши', 'пицц', 'столов', 'продукт', 'супермаркет',
  'кондитер', 'пекарн', 'мясо', 'рыб', 'молочн', 'напитк', 'доставка еды', 'кулинар', 'шашлык',
  'бургер', 'стрит-фуд', 'чай', 'кофе', 'консерв', 'овощ', 'фрукт', 'орех', 'макарон', 'сыр',
  'колбас', 'яйцо', 'специи', 'детское питание'];
const HEALTH = ['аптек', 'медицин', 'стоматолог', 'поликлиник', 'больниц', 'врач', 'диагност',
  'лаборатор', 'оптик', 'бад', 'фитопродукц', 'массаж', 'ветеринар', 'косметолог'];
const SALON = ['парикмахер', 'ногтевой', 'маникюр', 'педикюр', 'бров', 'ресниц', 'косметик',
  'салон красоты', 'барбершоп', 'визаж', 'эпиляц', 'загар', 'тату', 'спа', 'солярий'];

function categoryOf(rubrics = []) {
  const text = rubrics.join(' ').toLowerCase();
  if (HEALTH.some(word => text.includes(word))) return 'health';
  if (SALON.some(word => text.includes(word))) return 'salon';
  if (FOOD.some(word => text.includes(word))) return 'food';
  return 'services';
}

function clean(value, max) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function phoneOf(org) {
  const phone = org.phones?.[0];
  return phone ? clean(phone, 40) : null;
}

function externalReviewId(placeId, review) {
  return createHash('sha1').update(`${placeId}\n${review.author}\n${review.text}`).digest('hex');
}

export async function importCity(pool, { city = SLYUDYANKA, file = FILE, verbose = true } = {}) {
  const CITY = city;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const client = await pool.connect();
  let places = 0;
  let reviews = 0;
  try {
    await client.query('begin');
    await client.query(
      `insert into cities (slug, name, region, lat, lng) values ($1, $2, $3, $4, $5)
       on conflict (slug) do update set name = excluded.name, region = excluded.region,
         lat = excluded.lat, lng = excluded.lng, is_active = true`,
      [CITY.slug, CITY.name, CITY.region, CITY.lat, CITY.lng]);
    // Пересобираем только внешние отзывы этого города: свои отзывы и их
    // модерация не затрагиваются, а обновлённый снимок не плодит дубликаты.
    await client.query(
      `delete from reviews where source = '2gis' and place_id in (
         select id from places where source = '2gis' and city_slug = $1)`, [CITY.slug]);

    for (const org of data) {
      const lat = Number(org.lat) || CITY.lat;
      const lng = Number(org.lng) || CITY.lng;
      const rubrics = Array.isArray(org.rubrics) ? org.rubrics : [];
      const name = clean(org.name, 120) || 'Организация';
      const address = clean(org.address, 200) || CITY.name;
      const about = rubrics.length ? rubrics.join(' · ') : 'Организация из справочника 2ГИС';
      const category = categoryOf(rubrics);
      const metadata = {
        rubrics,
        sites: org.sites ?? [],
        phones: org.phones ?? [],
        schedule: org.schedule ?? null,
        source: '2gis',
        importedAt: new Date().toISOString(),
      };
      const sourceUrl = org.url || `https://2gis.ru/${CITY.slug}/firm/${org.id}`;
      const inserted = await client.query(
        `insert into places (city, city_slug, partner_id, name, category, district, address, lat, lng,
            about, phone, is_published, source, source_id, source_url, source_reviews_url,
            source_rating, source_rating_count, metadata)
         values ($1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10, true, '2gis', $11, $12, $13, $14, $15, $16::jsonb)
         on conflict (source, source_id) where source_id is not null do update set
           city = excluded.city, city_slug = excluded.city_slug, name = excluded.name,
           category = excluded.category, district = excluded.district, address = excluded.address,
           lat = excluded.lat, lng = excluded.lng, about = excluded.about, phone = excluded.phone,
           source_url = excluded.source_url, source_reviews_url = excluded.source_reviews_url,
           source_rating = excluded.source_rating, source_rating_count = excluded.source_rating_count,
           metadata = excluded.metadata
         returning id`,
        [CITY.name, CITY.slug, name, category, CITY.name, address, lat, lng, about, phoneOf(org),
          String(org.id), sourceUrl, `${sourceUrl}/tab/reviews`, org.rating ?? null, org.ratingCount ?? 0,
          JSON.stringify(metadata)]);
      const placeId = inserted.rows[0].id;
      places += 1;

      // В снимке лежат первые отзывы, которые 2ГИС отдаёт на странице. Общее
      // число отзывов хранится в source_rating_count и показывается отдельно.
      for (const review of org.reviews ?? []) {
        if (!review.text || !review.author) continue;
        const result = await client.query(
          `insert into reviews (booking_id, place_id, author_user_id, rating, body, status, source,
              external_id, external_url, author_name, published_at)
           values (null, $1, null, null, $2, 'published', '2gis', $3, $4, $5, null)
           on conflict (place_id, source, external_id) where source = '2gis' and external_id is not null
           do nothing`,
          [placeId, clean(review.text, 1000), externalReviewId(placeId, review),
            `${sourceUrl}/tab/reviews`, clean(review.author, 120)]);
        reviews += result.rowCount;
      }
    }
    await client.query(
      `update places p set rating_avg = null, rating_count = 0
       where p.source = '2gis' and not exists (
         select 1 from reviews r where r.place_id = p.id and r.source = 'own' and r.status = 'published')`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  if (verbose) console.log(`2ГИС ${CITY.name}: ${places} организаций, ${reviews} отзывов`);
  return { places, reviews, city: CITY.slug };
}

export function cityFromArgs(argv) {
  const args = Object.fromEntries(argv.slice(2).map(part => part.replace(/^--/, '').split('=')).filter(pair => pair.length === 2));
  return {
    slug: args.city || SLYUDYANKA.slug,
    name: args.name || SLYUDYANKA.name,
    region: args.region || SLYUDYANKA.region,
    lat: Number(args.lat) || SLYUDYANKA.lat,
    lng: Number(args.lng) || SLYUDYANKA.lng,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    const city = cityFromArgs(process.argv);
    const file = process.argv.find(part => part.startsWith('--file='))?.slice('--file='.length) || FILE;
    await importCity(pool, { city, file });
  } finally { await pool.end(); }
}
