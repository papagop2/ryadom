-- Детали заказа такси: адреса заездов, предварительное время, требования к
-- поездке, ожидание, подтверждение наличных и отметка проверенного водителя.
begin;

alter table trips add column stops jsonb not null default '[]'::jsonb;
alter table trips add column scheduled_for timestamptz;
alter table trips add column passengers smallint not null default 1
  check (passengers between 1 and 6);
alter table trips add column child_seat boolean not null default false;
alter table trips add column luggage boolean not null default false;
alter table trips add column pets boolean not null default false;
alter table trips add column ride_comment text not null default ''
  check (length(ride_comment) <= 300);
alter table trips add column arrived_at timestamptz;
alter table trips add column cash_confirmed_client_at timestamptz;
alter table trips add column cash_confirmed_driver_at timestamptz;

alter table driver_profiles add column is_verified boolean not null default false;

commit;
