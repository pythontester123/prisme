# Prisme

Convertir, compresser et archiver n'importe quel fichier, en local, avec une interface Liquid Glass.

## Lancer

Double-clique sur `start.bat` (ou `npm start`). Le navigateur s'ouvre sur http://localhost:3210.
Le serveur n'écoute que sur ta machine : aucun fichier ne part sur internet.

## Ce que ça fait

| Mode | Rôle |
|---|---|
| **Convertir** | Change le format de chaque fichier (choix du format par fichier, ou « Tout convertir en… »). |
| **Compresser** | Allège chaque fichier selon son type : images ré-encodées, vidéos en H.264/VP9, audio en débit réduit, documents Office avec images optimisées, PDF restructurés, le reste en 7z. Si le résultat n'est pas plus léger, l'original est rendu. |
| **Archiver** | Regroupe tous les fichiers en ZIP, 7Z ou TAR.GZ. |

Formats : images (JPG, PNG, WEBP, AVIF, HEIC, TIFF, GIF, SVG, BMP, ICO…), vidéo (MP4, MOV, MKV, AVI, WEBM…), audio (MP3, WAV, FLAC, OGG, M4A, OPUS…), documents (DOCX, PDF, Markdown, HTML, TXT), tableurs (XLSX, XLS, ODS, CSV, Numbers), données (JSON, YAML, XML), archives (ZIP, 7Z, TAR, GZ…). N'importe quel autre fichier peut être emballé en ZIP / 7Z / GZ.
La liste complète est dans l'app (bouton ⓘ).

## Mettre en ligne

Tout est prêt (Docker, limites, suppression automatique des fichiers) : voir [DEPLOY.md](DEPLOY.md).

## Pour aller plus loin

Installe [LibreOffice](https://www.libreoffice.org/) puis relance Prisme : il est détecté tout seul et débloque DOC, RTF, ODT, PPT/PPTX, Keynote, et des PDF fidèles depuis Word.

## Structure

- `server.js` — serveur Express local, file d'attente des tâches
- `lib/formats.js` — table des formats et des routes de conversion
- `lib/engine.js` — moteurs (sharp, ffmpeg, 7-Zip, pdf-lib, mammoth, SheetJS…)
- `public/` — interface (HTML, CSS Liquid Glass, JS)
