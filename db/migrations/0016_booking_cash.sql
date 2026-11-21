-- Запись на услугу тоже оплачивается наличными на месте. Партнёр отмечает
-- получение, клиент — передачу; до обоих подтверждений запись остаётся
-- подтверждённой и продолжает занимать окно.
begin;

alter table bookings
  add column cash_confirmed_client_at timestamptz,
  add column cash_confirmed_provider_at timestamptz;

commit;
