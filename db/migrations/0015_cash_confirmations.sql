-- Наличные подтверждают обе стороны: исполнитель отмечает получение,
-- клиент — передачу. Только после этого заказ или заявка считаются закрытыми.
begin;

alter type shop_order_status add value if not exists 'awaiting_cash';
alter type service_request_status add value if not exists 'awaiting_cash';

alter table shop_orders
  add column cash_confirmed_client_at timestamptz,
  add column cash_confirmed_provider_at timestamptz;

alter table service_requests
  add column cash_confirmed_client_at timestamptz,
  add column cash_confirmed_provider_at timestamptz;

commit;
