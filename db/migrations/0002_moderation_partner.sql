-- Этап 1: модерация отзывов, очередь уведомлений и редактирование карточек.
begin;

-- Новые отзывы сначала попадают оператору, а не в публичный рейтинг.
alter table reviews alter column status set default 'pending';
alter table reviews add column moderated_by uuid references users(id) on delete set null;
alter table reviews add column moderated_at timestamptz;
create index reviews_pending_idx on reviews (created_at) where status = 'pending';

-- Внешняя доставка уведомлений: канал, адрес и попытки. inapp — только в приложении.
alter table notifications add column channel text not null default 'inapp';
alter table notifications add column target text;
alter table notifications add column attempts smallint not null default 0;
alter table notifications add column last_error text;
create index notifications_pending_idx on notifications (created_at)
  where delivered_at is null and channel <> 'inapp';

-- Партнёр видит, когда карточку меняли.
alter table places add column updated_at timestamptz not null default now();
alter table offers add column updated_at timestamptz not null default now();

alter table reviews drop constraint if exists reviews_status_check;

commit;
