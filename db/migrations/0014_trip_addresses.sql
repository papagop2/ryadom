-- Полные адреса точек маршрута: label — короткая подпись, address — адрес геокодера.
alter table trips add column from_address text;
alter table trips add column to_address text;
