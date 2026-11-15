# Сторонние компоненты

## Strata

- Проект: [Niko1221/Strata](https://github.com/Niko1221/Strata).
- Проверенная версия: v0.2.13, commit `d2f096475817d4666c364c820b0ca830f751cfc5`.
- Авторские права: Copyright (c) 2026 Niko1221 and the Strata contributors.
- Лицензия: MIT; полный текст сохранён в `UPSTREAM-LICENSE`.

Strata не включена в этот репозиторий. Патч содержит необходимые фрагменты её исходного текста для проверки точек подключения. Собственные добавления и внешний runtime написаны Zoritism; они не заменяют уведомления об авторских правах upstream.

## QR Code Generator

- Проект: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator).
- Авторские права: Copyright (c) 2009 Kazuhiko Arase.
- Лицензия: MIT; полный текст — `extensions/strata-ui/vendor/qrcode.LICENSE`.
- Файл: `extensions/strata-ui/vendor/qrcode.mjs`; используется для QR-кода локального подключения.

## Средства среды выполнения

Установщик использует Node из выбранной Strata, компилятор .NET Framework и штатные средства Windows. Эти средства устанавливаются отдельно и не распространяются как часть Strata-Mod.
