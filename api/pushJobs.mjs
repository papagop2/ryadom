// Фоновые задачи: напоминание о записи и доставка push по уведомлениям.
import { pushEnabled, sendPush } from './push.mjs';

const LABELS = {
  booking_requested: ['Запись создана', 'Заявка ждёт подтверждения'],
  booking_new: ['Новая заявка', 'Клиент ждёт подтверждения'],
  booking_confirmed: ['Запись подтверждена', 'Ждём вас в назначенное время'],
  booking_completed: ['Запись завершена', 'Спасибо, что были с нами'],
  booking_cancelled: ['Запись отменена', 'Если это ошибка — свяжитесь с заведением'],
  booking_awaiting_cash: ['Оплата наличными', 'Партнёр ждёт подтверждения передачи'],
  booking_reminder: ['Напоминание о записи', 'Скоро начало — проверьте время'],
  booking_waitlist_open: ['Окно освободилось', 'Кто-то отменил запись — успейте записаться'],
  booking_rescheduled: ['Запись перенесена', 'Проверьте новое время визита'],
  review_moderated: ['Отзыв проверен', 'Опубликован после модерации'],
  service_offer: ['Новое предложение мастера', 'Откройте заявку и выберите цену'],
  service_offer_accepted: ['Мастер назначен', 'Заявка принята'],
  service_offer_declined: ['Предложение отклонено', 'Можно выбрать другого мастера'],
  service_cancelled: ['Заявка отменена', 'Откройте историю заявок'],
  service_assigned: ['Мастер назначен', 'Скоро свяжется'],
  service_in_progress: ['Работа началась', 'Мастер уже в пути'],
  service_completed: ['Заявка завершена', 'Оплата наличными'],
  service_awaiting_cash: ['Работа завершена', 'Подтвердите передачу наличных'],
  service_cash_confirmed: ['Оплата подтверждена', 'Спасибо'],
  shop_order_new: ['Новый заказ', 'Заказ ждёт подтверждения'],
  shop_placed: ['Заказ оформлен', 'Заведение скоро подтвердит'],
  shop_confirmed: ['Заказ подтверждён', 'Собираем заказ'],
  shop_ready: ['Заказ готов', 'Можно забирать или ждать курьера'],
  shop_completed: ['Заказ завершён', 'Спасибо за покупку'],
  shop_cancelled: ['Заказ отменён', 'Проверьте историю заказов'],
  shop_awaiting_cash: ['Заказ ждёт оплаты', 'Подтвердите передачу наличных'],
  shop_cash_confirmed: ['Оплата подтверждена', 'Спасибо'],
  delivery_assigned: ['Курьер назначен', 'Заказ скоро в пути'],
  delivery_picked_up: ['Курьер забрал заказ', 'Он уже едет к вам'],
  delivery_completed: ['Заказ доставлен', 'Подтвердите оплату наличными'],
  delivery_cash_confirmed: ['Доставка оплачена', 'Спасибо'],
  delivery_cancelled: ['Доставка отменена', 'Проверьте заказ'],
  delivery_available: ['Заказ готов к доставке', 'Можно брать в работу'],
  trip_requested: ['Заказ такси создан', 'Ждём предложения водителей'],
  trip_new: ['Новый заказ такси', 'Клиент ждёт цену'],
  trip_cancelled: ['Поездка отменена', 'Откройте историю поездок'],
  trip_offer: ['Новое предложение водителя', 'Клиент ждёт вашу цену'],
  trip_assigned: ['Водитель назначен', 'Машина уже едет'],
  trip_cash: ['Оплата поездки', 'Подтвердите расчёт наличными'],
  queue_ticket_new: ['Новый талон', 'Клиент встал в очередь'],
  queue_called: ['Вас вызвали', 'Подойдите к стойке'],
  queue_status: ['Очередь обновлена', 'Проверьте статус талона'],
  chat_message: ['Новое сообщение', 'Вам написали по заказу'],
};

function textFor(kind, payload) {
  const [title, fallback] = LABELS[kind] || ['Рядом', 'Новое событие'];
  let body = String(payload?.message || payload?.hint || fallback);
  if (kind === 'queue_called' || kind === 'queue_ticket_new') {
    body = `${payload?.place || 'Очередь'} · талон № ${payload?.number ?? '—'}`;
  } else if (kind === 'chat_message') {
    body = `${payload?.title || 'Заказ'} · ${payload?.body || fallback}`;
  } else if (kind === 'booking_reminder') {
    body = `${payload?.place || 'Запись'} · ${payload?.title || 'скоро начало'}`;
  } else if (kind === 'booking_confirmed' && payload?.place) {
    body = `${payload.place} · ${fallback}`;
  }
  return { title, body };
}

function urlFor(kind) {
  if (kind.startsWith('trip_')) return './?tab=taxi';
  if (kind.startsWith('shop_') || kind.startsWith('delivery_')) return './?tab=orders&view=shop';
  if (kind.startsWith('service_')) return './?tab=orders&view=requests';
  if (kind.startsWith('queue_')) return './?tab=orders&view=queue';
  if (kind === 'chat_message') return './?tab=orders&view=chat';
  return './?tab=orders';
}

export async function dispatchPush(pool, { logger = console, limit = 25 } = {}) {
  if (!pushEnabled()) return 0;
  const pending = await pool.query(
    `select id, user_id, kind, payload from notifications
     where delivered_at is null and attempts < 3
       and created_at > now() - interval '10 minutes'
       and kind <> 'login_code'
     order by id limit $1`, [limit]);
  let sent = 0;
  for (const row of pending.rows) {
    const subs = await pool.query(
      'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1', [row.user_id]);
    if (!subs.rows.length) {
      await pool.query('update notifications set delivered_at = now(), attempts = attempts + 1 where id = $1', [row.id]);
      continue;
    }
    const message = textFor(row.kind, row.payload || {});
    const payload = { ...message, kind: row.kind, notificationId: row.id, url: urlFor(row.kind) };
    let delivered = false;
    let lastError = null;
    for (const sub of subs.rows) {
      const result = await sendPush(sub, payload);
      if (result.ok) { delivered = true; sent += 1; break; }
      if (result.status === 404 || result.status === 410) {
        await pool.query('delete from push_subscriptions where id = $1', [sub.id]);
      }
      lastError = result.error || `HTTP ${result.status}`;
      if (result.status >= 400 && result.status < 500 && result.status !== 404 && result.status !== 410) {
        // Ошибка конкретного устройства не должна блокировать остальные подписки.
        await pool.query('update push_subscriptions set last_error = $2 where id = $1', [sub.id, lastError]);
      }
    }
    await pool.query(
      `update notifications set attempts = attempts + 1,
        delivered_at = case when $2 then now() else delivered_at end,
        last_error = $3 where id = $1`,
      [row.id, delivered, lastError]);
  }
  return sent;
}

export async function queueBookingReminders(pool) {
  const due = await pool.query(
    `select b.id, b.client_user_id, s.starts_at, o.title, p.name as place, p.id as place_id
     from bookings b
     join availability_slots s on s.id = b.slot_id
     join offers o on o.id = s.offer_id
     join places p on p.id = o.place_id
     where b.status = 'confirmed' and b.reminder_sent_at is null
       and s.starts_at between now() + interval '50 minutes' and now() + interval '70 minutes'
     order by s.starts_at limit 50`);
  for (const row of due.rows) {
    const marked = await pool.query(
      'update bookings set reminder_sent_at = now() where id = $1 and reminder_sent_at is null', [row.id]);
    if (!marked.rowCount) continue;
    await pool.query(
      `insert into notifications (user_id, kind, payload) values ($1, 'booking_reminder', $2)`,
      [row.client_user_id, JSON.stringify({
        bookingId: row.id, placeId: row.place_id, place: row.place,
        title: row.title, startsAt: row.starts_at,
      })]);
  }
  return due.rowCount;
}

export function startPushLoop(pool, { logger = console, pushEveryMs = 5000, reminderEveryMs = 60000 } = {}) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await queueBookingReminders(pool);
      await dispatchPush(pool, { logger });
    } catch (error) {
      logger.error?.('[push] ошибка фоновой доставки:', error.message);
    } finally { running = false; }
  };
  void tick();
  const pushTimer = setInterval(() => void tick(), pushEveryMs);
  const reminderTimer = setInterval(() => {
    if (stopped) return;
    void queueBookingReminders(pool).catch(error => logger.error?.('[push] напоминания:', error.message));
  }, reminderEveryMs);
  return () => {
    stopped = true;
    clearInterval(pushTimer);
    clearInterval(reminderTimer);
  };
}
