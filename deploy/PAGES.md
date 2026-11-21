# Демо на GitHub Pages

Публичная витрина дизайна: **https://papagop2.github.io/ryadom/**

Репозиторий: `papagop2/ryadom`, ветка `gh-pages`, корень сайта. Исходники остаются в
`superapp-pc2`; в GitHub лежит только собранная статика.

## Что это и чего здесь нет

- Это **демонстрация интерфейса**, а не боевой стенд. API заменён модулем
  `web/src/demo.ts`: каталог, окна, вход, записи, отзывы и кабинет партнёра работают
  в памяти браузера (`localStorage`).
- В демо встроен снимок **всего Слюдянского района: 880 организаций** (518 — 2ГИС,
  362 — OpenStreetMap/ODbL) из `web/src/demo-district.json`. Город по умолчанию —
  «Слюдянский район»; Демоград остаётся вторым городом для сценариев записи и
  кабинета партнёра. Карта показывает все 880 точек с кластерами; фото 2ГИС
  подгружаются с CDN, OSM-карточки помечены лицензией.
- PostgreSQL, Fastify и реальные уведомления не участвуют. Записи не видны другим
  устройствам и исчезают после очистки данных сайта. Web Push в демо скрыт:
  подписка требует боевого API, HTTPS и разрешения браузера; повторная запись
  и очередь работают в мок-API.
- Демо-телефоны те же: клиент `+79000000001`, партнёр `+79000000002`,
  оператор `+79000000003`. Код входа показывается на экране. Любой другой номер
  входит как клиент.
- Боевой стенд с настоящей БД по-прежнему доступен только в LAN
  (`https://192-168-50-150.sslip.io/`) и на Pages не опубликован.

## Сборка

Из `C:\Users\User\Desktop\netral2\superapp-pc2` (Node вызывается полным путём,
`MSYS_NO_PATHCONV=1` не даёт Git Bash превратить `/ryadom/` в путь Windows):

```bash
MSYS_NO_PATHCONV=1 VITE_DEMO=1 VITE_BASE=/ryadom/ VITE_OUT=../dist-pages \
  "/c/Program Files/nodejs/node.exe" node_modules/vite/bin/vite.js build --config vite.config.ts
MSYS_NO_PATHCONV=1 VITE_BASE=/ryadom/ VITE_OUT=../dist-pages \
  "/c/Program Files/nodejs/node.exe" web/build-pwa.mjs
cp dist-pages/index.html dist-pages/404.html
touch dist-pages/.nojekyll
```

`VITE_DEMO=1` включает мок-API, `VITE_BASE=/ryadom/` — подпапку проекта Pages,
`VITE_OUT=../dist-pages` — отдельный каталог, чтобы не затирать боевой `dist/`.
`404.html` нужен для прямых ссылок, `.nojekyll` отключает обработку Jekyll.

## Публикация

`dist-pages` — отдельный git-репозиторий с веткой `gh-pages`, родительский
репозиторий его игнорирует. После сборки:

```bash
cd dist-pages
git add -A
git commit -m "Ryadom demo build"
git push origin gh-pages
```

Pages собирается автоматически (source: branch `gh-pages`, path `/`). Проверка:

```bash
gh api repos/papagop2/ryadom/pages --jq '.status,.html_url'
curl -s -o /dev/null -w "%{http_code}\n" https://papagop2.github.io/ryadom/
```

## Обновление и кэш

`web/build-pwa.mjs` подставляет `BASE` в service worker и считает хеш файлов,
поэтому после публикации новой сборки браузер подхватывает новый кэш. Если на
телефоне видна старая версия — закрыть вкладку, открыть заново; при необходимости
очистить данные сайта.

## Ограничения GitHub Pages

- Только статика: нет серверных маршрутов, БД и секретов.
- Репозиторий публичный, поэтому в него нельзя класть `.env`, дампы и сертификаты.
  Здесь их нет.
- Pages не заменяет боевой стенд и проверку LAN-HTTPS; это отдельная витрина.
