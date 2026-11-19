// Генератор демоданных стенда. Идемпотентен: повторный запуск ничего не дублирует,
// полный сброс — только с явным флагом --reset (удаляет заказы, отзывы и каталог).
import { pathToFileURL } from 'node:url';
import { createPool } from '../api/db.mjs';

const partners = [
  { key: 'p1', name: 'Студия «Форма»', phone: '+79000000010' },
  { key: 'p2', name: 'Мастерская «Линия»', phone: '+79000000011' },
];

const places = [
  { key: 'forma', partner: 'p1', name: 'Форма', category: 'salon', district: 'Центр', address: 'ул. Мира, 12', lat: 55.7601, lng: 37.6186, about: 'Стрижки, укладка, окрашивание. Два мастера, окна с 10 до 19.', phone: '+79000000010' },
  { key: 'liniya', partner: 'p2', name: 'Линия', category: 'salon', district: 'Северный', address: 'пр. Победы, 4', lat: 55.7742, lng: 37.6011, about: 'Маникюр, педикюр, уход за руками.', phone: '+79000000011' },
  { key: 'ugol', partner: 'p2', name: 'Мастерская на углу', category: 'services', district: 'Центр', address: 'ул. Садовая, 3', lat: 55.7585, lng: 37.6290, about: 'Ремонт обуви и сумок, изготовление ключей.', phone: '+79000000011' },
  { key: 'tihiy-chas', partner: 'p1', name: 'Тихий час', category: 'health', district: 'Заречный', address: 'ул. Речная, 8', lat: 55.7490, lng: 37.6402, about: 'Массаж и восстановление после тренировок.', phone: null },
  { key: 'kuhnya', partner: 'p2', name: 'Кухня на районе', category: 'food', district: 'Южный', address: 'ул. Южная, 21', lat: 55.7402, lng: 37.6154, about: 'Домашние обеды, самовывоз с 11 до 20.', phone: '+79000000011' },
  { key: 'glaz', partner: 'p1', name: 'Глаз да глаз', category: 'services', district: 'Северный', address: 'ул. Северная, 15', lat: 55.7801, lng: 37.6103, about: 'Мелкий ремонт одежды, подгонка по фигуре.', phone: null },
];

const offers = [
  { place: 'forma', title: 'Стрижка и укладка', minutes: 60, price: 120000 },
  { place: 'forma', title: 'Окрашивание корней', minutes: 90, price: 240000 },
  { place: 'liniya', title: 'Маникюр без покрытия', minutes: 45, price: 100000 },
  { place: 'liniya', title: 'Педикюр с покрытием', minutes: 75, price: 190000 },
  { place: 'ugol', title: 'Ремонт обуви: профилактика', minutes: 20, price: 60000 },
  { place: 'tihiy-chas', title: 'Массаж спины 45 минут', minutes: 45, price: 180000 },
  { place: 'kuhnya', title: 'Обед дня (самовывоз)', minutes: 15, price: 45000 },
  { place: 'glaz', title: 'Подгонка брюк', minutes: 30, price: 80000 },
];

const products = [
  { place: 'kuhnya', title: 'Обед дня', description: 'Суп, горячее и напиток', price: 45000, stock: 12, unit: 'порция' },
  { place: 'kuhnya', title: 'Суп куриный', description: 'С домашней лапшой', price: 22000, stock: 8, unit: 'порция' },
  { place: 'kuhnya', title: 'Компот', description: 'Из ягод, без сахара', price: 8000, stock: 15, unit: 'стакан' },
  { place: 'ugol', title: 'Крем для обуви', description: 'Нейтральный, 50 мл', price: 35000, stock: 6, unit: 'шт' },
];

const demoDrivers = [
  { phone: '+79000000004', name: 'Водитель Демо', car: 'Kia Rio', plate: 'А123ВС77' },
];

const demoUsers = [
  { phone: '+79000000001', name: 'Клиент Демо', roles: [['client', null]] },
  { phone: '+79000000002', name: 'Партнёр Демо', roles: [['partner', 'p1'], ['client', null]] },
  { phone: '+79000000003', name: 'Оператор Демо', roles: [['operator', null]] },
];

export async function seed(pool, { reset = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (reset) {
      await client.query('delete from shop_order_events');
      await client.query('delete from shop_order_items');
      await client.query('delete from shop_orders');
      await client.query('delete from products');
      await client.query('delete from service_request_events');
      await client.query('delete from service_requests');
      await client.query('delete from reviews');
      await client.query('delete from booking_events');
      await client.query('delete from bookings');
      await client.query('delete from availability_slots');
      await client.query('delete from offers');
      await client.query('delete from places');
      await client.query('delete from memberships where partner_id is not null');
      await client.query('delete from partners');
    }

    const partnerIds = new Map();
    for (const partner of partners) {
      const found = await client.query('select id from partners where name = $1 order by created_at limit 1', [partner.name]);
      if (found.rows[0]) {
        partnerIds.set(partner.key, found.rows[0].id);
        continue;
      }
      const { rows } = await client.query(
        `insert into partners (name, contact_phone, status) values ($1, $2, 'approved') returning id`,
        [partner.name, partner.phone]);
      partnerIds.set(partner.key, rows[0].id);
    }

    // Карточки и услуги ищутся по естественному ключу (партнёр+название,
    // заведение+название), поэтому повторный запуск обновляет их, а не дублирует.
    const placeIds = new Map();
    for (const place of places) {
      const partnerId = partnerIds.get(place.partner);
      const found = await client.query(
        'select id from places where partner_id = $1 and name = $2 order by created_at limit 1',
        [partnerId, place.name]);
      if (found.rows[0]) {
        await client.query(
          `update places set category = $2, district = $3, address = $4, lat = $5, lng = $6,
                  about = $7, phone = $8, is_published = true
           where id = $1`,
          [found.rows[0].id, place.category, place.district, place.address,
            place.lat, place.lng, place.about, place.phone]);
        placeIds.set(place.key, found.rows[0].id);
        continue;
      }
      const { rows } = await client.query(
        `insert into places (partner_id, name, category, district, address, lat, lng, about, phone)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [partnerId, place.name, place.category, place.district, place.address,
          place.lat, place.lng, place.about, place.phone]);
      placeIds.set(place.key, rows[0].id);
    }

    const offerIds = [];
    for (const offer of offers) {
      const placeId = placeIds.get(offer.place);
      const found = await client.query(
        'select id from offers where place_id = $1 and title = $2 order by created_at limit 1',
        [placeId, offer.title]);
      if (found.rows[0]) {
        await client.query(
          'update offers set duration_min = $2, price_cents = $3, is_active = true where id = $1',
          [found.rows[0].id, offer.minutes, offer.price]);
        offerIds.push({ id: found.rows[0].id, minutes: offer.minutes });
        continue;
      }
      const { rows } = await client.query(
        `insert into offers (place_id, title, duration_min, price_cents) values ($1, $2, $3, $4) returning id`,
        [placeId, offer.title, offer.minutes, offer.price]);
      offerIds.push({ id: rows[0].id, minutes: offer.minutes });
    }

    let productCount = 0;
    for (const product of products) {
      const placeId = placeIds.get(product.place);
      const found = await client.query(
        'select id from products where place_id = $1 and title = $2 order by created_at limit 1',
        [placeId, product.title]);
      if (found.rows[0]) {
        await client.query(
          'update products set description = $2, price_cents = $3, unit = $4, is_active = true where id = $1',
          [found.rows[0].id, product.description, product.price, product.unit]);
      } else {
        await client.query(
          `insert into products (place_id, title, description, price_cents, stock_qty, unit)
           values ($1, $2, $3, $4, $5, $6)`,
          [placeId, product.title, product.description, product.price, product.stock, product.unit]);
      }
      productCount += 1;
    }

    // Окна на 10 дней вперёд: 10:00, 12:00, 14:00, 16:00, 18:00 по Москве.
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    let slots = 0;
    for (let day = 0; day < 10; day += 1) {
      const date = new Date(start.getTime() + (day + 1) * 86400000).toISOString().slice(0, 10);
      for (const offer of offerIds) {
        for (const hour of [10, 12, 14, 16, 18]) {
          const startsAt = `${date}T${String(hour).padStart(2, '0')}:00:00+03:00`;
          const endsAt = new Date(new Date(startsAt).getTime() + offer.minutes * 60000).toISOString();
          const inserted = await client.query(
            `insert into availability_slots (offer_id, starts_at, ends_at) values ($1, $2, $3)
             on conflict (offer_id, starts_at) do nothing`, [offer.id, startsAt, endsAt]);
          slots += inserted.rowCount;
        }
      }
    }

    for (const user of demoUsers) {
      const { rows } = await client.query(
        `insert into users (phone, display_name) values ($1, $2)
         on conflict (phone) do update set display_name = excluded.display_name returning id`,
        [user.phone, user.name]);
      for (const [role, partnerKey] of user.roles) {
        await client.query(
          `insert into memberships (user_id, role, partner_id) values ($1, $2, $3)
           on conflict (user_id, role) do nothing`,
          [rows[0].id, role, partnerKey ? partnerIds.get(partnerKey) : null]);
      }
    }

    for (const driver of demoDrivers) {
      const { rows } = await client.query(
        `insert into users (phone, display_name) values ($1, $2)
         on conflict (phone) do update set display_name = excluded.display_name returning id`,
        [driver.phone, driver.name]);
      await client.query(
        `insert into memberships (user_id, role) values ($1, 'driver') on conflict (user_id, role) do nothing`,
        [rows[0].id]);
      await client.query(
        `insert into driver_profiles (user_id, car_model, plate) values ($1, $2, $3)
         on conflict (user_id) do update set car_model = excluded.car_model, plate = excluded.plate`,
        [rows[0].id, driver.car, driver.plate]);
    }

    await client.query('commit');
    return { partners: partnerIds.size, places: placeIds.size, offers: offerIds.length, products: productCount, slots };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    const result = await seed(pool, { reset: process.argv.includes('--reset') });
    console.log('демоданные:', JSON.stringify(result));
  } catch (error) {
    console.error('демоданные не созданы:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
