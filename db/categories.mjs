// Категории каталога. 2ГИС отдаёт рубрики, OSM — теги; сводим их к четырём
// разделам приложения. Важны сильные признаки: «компьютерная диагностика»
// автомобиля не должна попадать в здоровье, а магазин косметики — в красоту.

const AUTO = ['авто', 'шин', 'кузов', 'двигател', 'запчаст', 'развал-схожд', 'техосмотр', 'азс', 'агзс', 'заправк'];
const LODGING = ['гостиниц', 'гостевой дом', 'отель', 'хостел', 'кемпинг', 'база отдыха', 'апартамент',
  'турбаза', 'туристический комплекс', 'мотел'];
const HEALTH = ['аптек', 'больниц', 'поликлиник', 'стоматолог', 'медицин', 'врач', 'клиник',
  'лаборатор', 'оптик', 'ветеринар', 'роддом', 'диспансер', 'санатор', 'реабилитац'];
const HEALTH_EXTRA = ['массаж'];
const SALON = ['парикмахер', 'ногтевой', 'маникюр', 'педикюр', 'бров', 'ресниц', 'перманентный макияж',
  'визаж', 'эпиляц', 'загар', 'солярий', 'тату', 'барбершоп', 'салон красоты', 'студия красоты',
  'дом красоты', 'косметолог', 'спа-салон', 'спа центр', 'спа процедур'];
const FOOD = ['кафе', 'ресторан', 'кофейн', 'бар', 'суши', 'пицц', 'столов', 'быстрое питание',
  'фастфуд', 'доставка еды', 'кулинар', 'шашлык', 'бургер', 'кондитер', 'пекарн', 'мороженое',
  'супермаркет', 'минимаркет', 'продуктов', 'алкомаркет', 'алкогольн', 'мясн', 'мясо',
  'рыбн', 'рыба и морепродукты', 'молочн', 'напитк', 'чай', 'кофе', 'овощ', 'фрукт', 'орех',
  'макарон', 'сыр', 'колбас', 'яйцо', 'специи', 'детское питание', 'хлеб', 'бакалея', 'гастроном'];

const hasAny = (text, words) => words.some(word => text.includes(word));

function fromTags(tags = {}) {
  if (tags.healthcare) return 'health';
  if (['pharmacy', 'hospital', 'clinic', 'doctors', 'dentist', 'veterinary'].includes(tags.amenity)) return 'health';
  if (tags.shop === 'hairdresser' || tags.shop === 'beauty') return 'salon';
  if (['cafe', 'restaurant', 'bar', 'pub', 'fast_food', 'food_court', 'ice_cream', 'marketplace'].includes(tags.amenity)) return 'food';
  if (['supermarket', 'convenience', 'greengrocer', 'butcher', 'bakery', 'confectionery', 'seafood',
    'alcohol', 'beverages', 'dairy', 'cheese', 'meat', 'fish', 'farm', 'wine', 'ice_cream'].includes(tags.shop)) return 'food';
  if (tags.tourism) return 'services';
  return null;
}

export function categoryOf({ rubrics = [], tags = {}, name = '' } = {}) {
  const fromTag = fromTags(tags);
  if (fromTag) return fromTag;
  const values = (Array.isArray(rubrics) ? rubrics : []).map(value => String(value).toLowerCase());
  const text = (values.length ? values.join(' ') : String(name).toLowerCase()).replace(/ё/g, 'е');
  if (!text) return 'services';
  if (hasAny(text, AUTO)) return 'services';
  if (hasAny(text, LODGING)) return 'services';
  if (hasAny(text, HEALTH)) return 'health';
  if (hasAny(text, SALON)) return 'salon';
  if (hasAny(text, HEALTH_EXTRA)) return 'health';
  if (hasAny(text, FOOD)) return 'food';
  return 'services';
}
