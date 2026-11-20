-- Класс поездки: эконом, комфорт или минивэн. Цена по-прежнему считается на
-- сервере; тариф нужен, чтобы показать выбранный класс в истории и у водителя.
begin;

alter table trips add column tariff text not null default 'economy';

alter table trips add constraint trips_tariff_check
  check (tariff in ('economy', 'comfort', 'minivan'));

commit;
