# Deploy VPS — Aurix API Musicanoba

## Comando normal

```bash
cd ~/aurix-api-{slug} && git pull && npm ci && npm run build && npm run db:migrate && sudo pm2 restart aurix-api-{slug}
```

Orden: código → deps → build → migraciones MySQL → restart PM2.

Al reiniciar, el boot también reaplica `sql/` (idempotente). El `db:migrate` explícito deja ver el resultado en consola antes del restart.

---

## Si `git pull` falla

### 1. `dubious ownership`

```
fatal: detected dubious ownership in repository at '/home/fenecstudio/aurix-api-{slug}'
```

Git no confía en el directorio (dueño distinto al usuario actual).

```bash
git config --global --add safe.directory /home/fenecstudio/aurix-api-{slug}
```

### 2. `cannot open .git/FETCH_HEAD: Permission denied`

Archivos del repo (sobre todo `.git/`) pertenecen a otro usuario (p. ej. `root` por un deploy con `sudo`).

```bash
# Ver dueño
ls -la ~/aurix-api-{slug} | head
ls -la ~/aurix-api-{slug}/.git | head

# Corregir
sudo chown -R fenecstudio:fenecstudio ~/aurix-api-{slug}
```

Luego repetí el comando normal de deploy.

---

## Checklist rápido

1. `safe.directory` configurado (una sola vez por máquina/usuario)
2. Ownership del repo = `fenecstudio:fenecstudio`
3. `git pull` → `npm ci` → `npm run build` → `npm run db:migrate` → `sudo pm2 restart aurix-api-{slug}`
4. Verificar: `pm2 status`, `pm2 logs aurix-api-{slug} --lines 50`, y `curl -s https://{slug}.api.aurixerp.com/api/health`

---

## Evitar que vuelva a pasar

- No clonar ni hacer `git pull` con `sudo`.
- No correr `npm` / scripts de git como `root` dentro del home de `fenecstudio`.
- Si alguna vez usaste `sudo git …` o `sudo npm …`, volvé a correr el `chown` de arriba.
