# Mettre Prisme en ligne

Prisme est prêt à être hébergé : tout est dans le `Dockerfile` (ffmpeg, 7-Zip et LibreOffice inclus).

## Option la plus simple : Render

1. Crée un dépôt GitHub et envoie-y ce dossier (le `.gitignore` exclut déjà `node_modules`).
2. Sur [render.com](https://render.com) : **New → Blueprint**, choisis le dépôt. Render lit `render.yaml` et construit l'image tout seul.
3. Une fois en ligne, ajoute ton nom de domaine dans **Settings → Custom Domains**. Le HTTPS est automatique.

`render.yaml` utilise l'**offre gratuite** : le site s'endort après 15 min sans visite (premier chargement ~1 min ensuite), 512 Mo de mémoire, 100 Mo max par fichier, un traitement à la fois.
Parfait pour images, audio, documents et tableurs ; les grosses vidéos seront lentes.
Pour plus de puissance, passe `plan: free` à `plan: starter` (payant) et remonte `MAX_FILE_MB` / `MAX_PARALLEL`.

## Autres hébergeurs

N'importe quel service qui lance une image Docker convient (Railway, Fly.io, un VPS avec Docker…) :

```bash
docker build -t prisme .
docker run -d -p 80:3210 --restart unless-stopped prisme
```

Sur un VPS, place un proxy HTTPS devant (Caddy ou Nginx + Let's Encrypt).

## Réglages

| Variable | Défaut en ligne | Rôle |
|---|---|---|
| `MAX_FILE_MB` | 500 | Taille maximale d'un fichier |
| `MAX_FILES` | 50 | Fichiers maximum par envoi |
| `FILE_TTL_MIN` | 60 | Minutes avant suppression automatique des résultats |
| `RATE_LIMIT` | 60 | Traitements max par visiteur toutes les 10 min |
| `MAX_QUEUE` | 40 | Au-delà, les nouveaux envois sont refusés poliment |
| `MAX_PARALLEL` | moitié des cœurs (1 à 3) | Traitements lourds simultanés |
| `JOB_TIMEOUT_MIN` | 20 | Durée max d'un traitement |
| `MAX_EXTRACT_MB` | 4096 | Taille max d'une archive une fois décompressée |
| `TRUST_PROXY` | 1 | Nombre de proxys devant le serveur (pour l'IP réelle) |

## Ce qui protège le service

- Fichiers originaux effacés dès la fin du traitement, résultats effacés après `FILE_TTL_MIN` minutes, tout est vidé au redémarrage.
- Liens de téléchargement impossibles à deviner (identifiants aléatoires de 128 bits).
- Limites de taille, de nombre, de débit par visiteur et de durée ; refus des archives piégées (« zip bombs »).
- Aucun chemin interne ni détail technique dans les messages d'erreur.
- En-têtes de sécurité (CSP, anti-iframe, nosniff).

## Avant d'ouvrir au public

- **Mentions légales et politique de confidentialité** : obligatoires en France dès qu'un site reçoit des fichiers de visiteurs (RGPD). Indique l'hébergeur, la durée de conservation (1 h) et l'absence de partage.
- **Coûts** : la vidéo consomme beaucoup de CPU. Surveille l'usage les premiers jours et ajuste `MAX_FILE_MB` / `MAX_PARALLEL`.
