-- OSM-слой не даёт структурированных часов в снимке: пустые строки хуже
-- честного «часы не указаны». 2ГИС-часы остаются.
delete from place_hours h
using places p
where h.place_id = p.id and p.source = 'osm';
