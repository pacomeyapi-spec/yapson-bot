# YapsonBot — Cloud Worker

Service Node.js qui fait tourner YapsonServer 24h/24 sur Railway.
Inclut un dashboard web pour gérer les comptes et la configuration.

## Variables d'environnement Railway (configuration initiale)

| Variable | Description |
|---|---|
| `YAPSON_URL` | URL de YapsonPress |
| `YAPSON_USER` | Identifiant YapsonPress |
| `YAPSON_PASS` | Mot de passe YapsonPress |
| `MGMT_URL` | URL de my-managment |
| `MGMT_USER` | Identifiant my-managment |
| `MGMT_PASS` | Mot de passe my-managment |
| `FONCTION` | `F1` ou `F2` |
| `SENDERS` | `Wave Business,+454,MobileMoney,MoovMoney` |
| `INTERVAL_SEC` | Intervalle en secondes (défaut: 15) |
| `F2_CONF_MIN` | Seuil confirmation F2 en minutes (défaut: 10) |
| `F2_REJ_ON` | Rejet auto F2: `true` ou `false` |
| `F2_REJ_MIN` | Seuil rejet F2 en minutes (défaut: 15) |

## Dashboard web

Une fois déployé, ouvre l'URL Railway publique pour :
- **Changer les comptes** YapsonPress et my-managment sans redéploiement
- **Modifier la configuration** (fonction, expéditeurs, seuils)
- **Saisir le code 2FA** quand my-managment le demande
- **Démarrer / Arrêter** le bot
- **Voir les logs** en temps réel (rafraîchissement automatique toutes les 10s)

## Cycle de session my-managment

La session dure **12 heures**. Quand elle expire :
1. Le dashboard affiche automatiquement **"📱 Code 2FA requis"**
2. Tu reçois le SMS avec le code à 6 chiffres
3. Tu le saisis dans le formulaire → le bot reprend immédiatement
